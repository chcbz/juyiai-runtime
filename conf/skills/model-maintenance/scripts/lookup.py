"""Query the execution-bound model price resource. Never acquire credentials."""
import http.client
import json
import socket
import sys


class ExecutionConnection(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect('/business-api.sock')


def main(model):
    connection = ExecutionConnection('localhost', timeout=15)
    try:
        connection.request('POST', '/model-prices/lookup', json.dumps({'model': model}),
                           {'Content-Type': 'application/json'})
        response = connection.getresponse()
        if response.status != 200:
            sys.exit('模型查询未成功（HTTP %d）；未执行写入。' % response.status)
        print(json.dumps(json.load(response), ensure_ascii=False))
    except (ValueError, OSError, http.client.HTTPException):
        sys.exit('本次执行未能取得有效查询回执。')
    finally:
        connection.close()


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit('usage: lookup.py MODEL_ID')
    main(sys.argv[1])
