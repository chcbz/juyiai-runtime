#!/usr/bin/env python3
"""Private, CPU-only HTTP speech adapter. No CYF task, wallet or lifecycle authority."""
import argparse
import concurrent.futures
import hashlib
import hmac
import io
import json
import os
from pathlib import Path
import threading
import uuid
from email import policy
from email.parser import BytesParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL = 'faster-whisper-small-community-1'


def speaker_at(start, end, turns):
    scores = {}
    for turn in turns:
        overlap = max(0.0, min(end, turn['end']) - max(start, turn['start']))
        if overlap:
            scores[turn['speaker']] = scores.get(turn['speaker'], 0.0) + overlap
    return max(scores, key=scores.get) if scores else 'UNKNOWN'


def align_words(segments, turns):
    """Assign actual ASR words rather than whole cross-speaker ASR segments."""
    result = []
    words = []
    for segment in segments:
        units = segment.get('words') or [{'start': segment['start'], 'end': segment['end'], 'word': segment['text']}]
        for item in units:
            word = dict(item, speaker=speaker_at(item['start'], item['end'], turns))
            words.append(word)
            if result and result[-1]['speaker'] == word['speaker'] and word['start'] - result[-1]['end'] <= 1.0:
                result[-1]['end'] = word['end']
                result[-1]['text'] += word['word']
            else:
                result.append({'start': word['start'], 'end': word['end'], 'text': word['word'], 'speaker': word['speaker']})
    for i, row in enumerate(result):
        row['id'] = i
        row['text'] = row['text'].strip()
    return result, words


def multipart(content_type, body):
    message = BytesParser(policy=policy.default).parsebytes(('Content-Type: ' + content_type + '\r\nMIME-Version: 1.0\r\n\r\n').encode() + body)
    if not message.is_multipart():
        raise ValueError('multipart/form-data required')
    fields = {}
    for part in message.iter_parts():
        name = part.get_param('name', header='content-disposition')
        if name not in ('file', 'model', 'language', 'response_format') or name in fields:
            raise ValueError('unsupported or duplicate multipart field')
        fields[name] = part.get_payload(decode=True)
    if not fields.get('file'):
        raise ValueError('nonempty file required')
    if fields.get('model', b'').decode() != MODEL:
        raise ValueError('unsupported model')
    fmt = fields.get('response_format', b'json').decode()
    if fmt not in ('json', 'verbose_json', 'diarized_json'):
        raise ValueError('unsupported response format')
    language = fields.get('language', b'').decode() or None
    return fields['file'], language


class SpeechEngine:
    def __init__(self, config):
        self.config = config
        self.whisper = None
        self.pipeline = None
        # Verify immutable model bytes at service start, not on every request.
        for key, manifest_key in [('asrModel', 'asrManifest'), ('diarizationModel', 'diarizationManifest')]:
            manifest = json.loads(Path(config[manifest_key]).read_text())
            for entry in manifest['files']:
                file = Path(config[key]) / entry['name']
                if file.stat().st_size != entry['size'] or hashlib.sha256(file.read_bytes()).hexdigest() != entry['sha256']:
                    raise ValueError('model integrity mismatch')

    def __call__(self, audio, language):
        import torch
        from faster_whisper import WhisperModel
        from faster_whisper.audio import decode_audio
        from pyannote.audio import Pipeline
        torch.set_num_threads(2)
        waveform = decode_audio(io.BytesIO(audio), sampling_rate=16000)
        if self.whisper is None:
            self.whisper = WhisperModel(self.config['asrModel'], device='cpu', compute_type='int8', cpu_threads=2, num_workers=1, local_files_only=True)
        iterator, info = self.whisper.transcribe(waveform, language=language, beam_size=5, word_timestamps=True, vad_filter=True, condition_on_previous_text=False)
        segments = [{'start': s.start, 'end': s.end, 'text': s.text,
                     'words': [{'start': w.start, 'end': w.end, 'word': w.word, 'probability': w.probability} for w in (s.words or [])]} for s in iterator]
        if self.pipeline is None:
            self.pipeline = Pipeline.from_pretrained(self.config['diarizationModel'])
        output = self.pipeline({'waveform': torch.from_numpy(waveform).unsqueeze(0), 'sample_rate': 16000})
        annotation = output.exclusive_speaker_diarization
        turns = [{'start': t.start, 'end': t.end, 'speaker': label} for t, _, label in annotation.itertracks(yield_label=True)]
        aligned, words = align_words(segments, turns)
        return {'text': ''.join(s['text'] for s in segments).strip(), 'language': info.language, 'duration': info.duration,
                'segments': aligned, 'words': words, 'speaker_turns': turns, 'model': MODEL, 'usage': None,
                'source_sha256': hashlib.sha256(audio).hexdigest(),
                'speaker_label_kind': 'anonymous_clusters_not_person_identities',
                'alignment': 'word_maximum_time_overlap; UNKNOWN where no speech overlap; recognition and boundaries require review'}


class Adapter:
    def __init__(self, token, state, engine, fingerprint):
        self.token = token
        self.state = Path(state)
        self.state.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.engine = engine
        self.fingerprint = fingerprint
        self.lock = threading.Lock()

    def transcribe(self, audio, language):
        source = hashlib.sha256(audio).hexdigest()
        key = hashlib.sha256(json.dumps([source, language, self.fingerprint]).encode()).hexdigest()
        path = self.state / (key + '.json')
        # Serialize model inference; duplicate exact input reuses the durable local result.
        with self.lock:
            if path.exists():
                return path.read_bytes()
            result = self.engine(audio, language)
            data = (json.dumps(result, ensure_ascii=False) + '\n').encode()
            temporary = path.with_suffix('.' + uuid.uuid4().hex + '.tmp')
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'wb') as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
            directory = os.open(self.state, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
            return data


def handler(adapter):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def log_message(self, *_):
            pass  # Never log audio, auth or user text.

        def respond(self, status, value):
            data = json.dumps(value).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(data)

        def authenticated(self):
            supplied = self.headers.get('Authorization', '')
            if not hmac.compare_digest(supplied.encode(), ('Bearer ' + adapter.token).encode()):
                self.close_connection = True
                self.respond(401, {'error': {'code': 'UNAUTHORIZED'}})
                return False
            return True

        def do_GET(self):
            if not self.authenticated():
                return
            if self.path != '/health':
                return self.respond(404, {'error': {'code': 'NOT_FOUND'}})
            self.respond(200, {'status': 'ready', 'model': MODEL})

        def do_POST(self):
            if not self.authenticated():
                return
            if self.path != '/v1/audio/transcriptions':
                self.close_connection = True
                return self.respond(404, {'error': {'code': 'NOT_FOUND'}})
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if length <= 0:
                    raise ValueError('Content-Length required')
                body = self.rfile.read(length)
                if len(body) != length:
                    raise ValueError('incomplete body')
                audio, language = multipart(self.headers.get('Content-Type', ''), body)
            except (ValueError, UnicodeError):
                self.close_connection = True
                return self.respond(400, {'error': {'code': 'INVALID_AUDIO_REQUEST'}})
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Transfer-Encoding', 'chunked')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Accel-Buffering', 'no')
            self.send_header('X-Request-Id', hashlib.sha256(audio).hexdigest())
            self.end_headers()
            # Legal JSON leading whitespace keeps a long CPU operation observable to
            # transports. This is not an inference deadline or fake progress.
            def chunk(data):
                self.wfile.write(('%x\r\n' % len(data)).encode() + data + b'\r\n')
                self.wfile.flush()
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                future = pool.submit(adapter.transcribe, audio, language)
                try:
                    chunk(b'\n')
                    while True:
                        try:
                            data = future.result(timeout=15)
                            break
                        except concurrent.futures.TimeoutError:
                            chunk(b'\n')
                        except Exception:
                            data = b'{"error":{"code":"LOCAL_TRANSCRIPTION_FAILED"}}\n'
                            break
                    chunk(data)
                    self.wfile.write(b'0\r\n\r\n')
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    # Inference completes and saves its result despite disconnect.
                    pass
    return Handler


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--config', type=Path, required=True)
    a = p.parse_args()
    os.umask(0o077)
    st = a.config.stat()
    if st.st_uid != os.geteuid() or st.st_mode & 0o077:
        raise ValueError('private operator configuration required')
    config = json.loads(a.config.read_text())
    engine = SpeechEngine(config)
    fingerprint = hashlib.sha256(Path(config['asrManifest']).read_bytes() + Path(config['diarizationManifest']).read_bytes() + Path(__file__).read_bytes()).hexdigest()
    adapter = Adapter(config['apiKey'], config['state'], engine, fingerprint)
    server = ThreadingHTTPServer(('127.0.0.1', config['port']), handler(adapter))
    print('AUDIO_SERVICE_READY', flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
