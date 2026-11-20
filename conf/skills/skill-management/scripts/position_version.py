"""Query the execution-bound position skill version resource. Never acquire credentials."""
import http.client
import json
import os
import hashlib
import socket
import sys


class ExecutionConnection(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect('/business-api.sock')


def exchange(resource, verb, data, archive=None):
    connection = ExecutionConnection('localhost', timeout=15)
    try:
        if archive is None:
            connection.request('POST', '/%s/%s' % (resource, verb), json.dumps(data),
                               {'Content-Type': 'application/json'})
        else:
            with open(archive, 'rb') as src:
                size = os.fstat(src.fileno()).st_size
                if not 0 < size <= 16 * 1024 * 1024:
                    sys.exit('技能 ZIP 大小必须在 1 字节至 16 MiB 之间')
                digest = hashlib.sha256()
                for chunk in iter(lambda: src.read(65536), b''):
                    digest.update(chunk)
                if data['payload'].get('packageSha256') != digest.hexdigest():
                    sys.exit('packageSha256 与所选 ZIP 不符；未提交')
                src.seek(0)
                metadata = json.dumps(data, ensure_ascii=False).encode('utf-8')
                connection.putrequest('POST', '/%s/%s' % (resource, verb))
                connection.putheader('Content-Type', 'application/octet-stream')
                connection.putheader('Content-Length', str(len(metadata) + size))
                connection.putheader('X-Cyf-Metadata-Length', str(len(metadata)))
                connection.endheaders(metadata)
                connection.send(src)
        response = connection.getresponse()
        if response.status != 200:
            sys.exit('业务回执不可用（HTTP %d）。不能据此断言写入未发生。' % response.status)
        print(json.dumps(json.load(response), ensure_ascii=False))
    except (ValueError, OSError, http.client.HTTPException):
        sys.exit('未取得有效回执，不重发写入。')
    finally:
        connection.close()


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='查询岗位技能的目标版本或提交受控升级')
    commands = parser.add_subparsers(dest='action', required=True)
    for action, fields in [('lookup', ('skillKey',)),
                           ('commit', ('skillKey', 'expectedProductVersionId', 'targetProductVersionId')),
                           ('receipt', ('skillKey', 'expectedProductVersionId', 'targetProductVersionId'))]:
        command = commands.add_parser(action)
        for field in fields:
            command.add_argument(field)
        command.set_defaults(fields=fields)
    args = parser.parse_args()
    exchange('position-skill-versions', args.action, {field: getattr(args, field) for field in args.fields})
