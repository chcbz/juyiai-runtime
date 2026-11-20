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


def exchange(resource, verb, data):
    connection = ExecutionConnection('localhost', timeout=15)
    try:
        connection.request('POST', '/%s/%s' % (resource, verb), json.dumps(data),
                           {'Content-Type': 'application/json'})
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
    parser = argparse.ArgumentParser(description='本次执行内的模型维护')
    commands = parser.add_subparsers(dest='action')
    for name, resource, verb, fields in [
        ('price', 'model-prices', 'lookup', ('model',)),
        ('add-price', 'model-prices', 'commit', ('model',)),
        ('price-receipt', 'model-prices', 'receipt', ('model',)),
        ('binding', 'hero-models', 'lookup', ('personaCode',)),
        ('bind', 'hero-models', 'commit', ('personaCode','expectedModel','model')),
        ('binding-receipt', 'hero-models', 'receipt', ('personaCode','expectedModel','model')),
    ]:
        cmd = commands.add_parser(name)
        cmd.set_defaults(resource=resource, verb=verb, fields=fields)
        for field in fields:
            cmd.add_argument(field)
    args = parser.parse_args()
    if not args.action:
        parser.error('需要子命令')
    exchange(args.resource, args.verb, {field:getattr(args,field) for field in args.fields})
