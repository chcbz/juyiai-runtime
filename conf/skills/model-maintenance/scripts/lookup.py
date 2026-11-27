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
    for name, verb in [('route-lookup', 'lookup'), ('route-commit', 'commit'), ('route-receipt', 'receipt')]:
        cmd = commands.add_parser(name)
        cmd.set_defaults(resource='cost-route-bindings', verb=verb, fields=None)
        cmd.add_argument('request_json', help='确切路由引用及映射请求JSON，不读取配置或推断渠道')
    args = parser.parse_args()
    if not args.action:
        parser.error('需要子命令')
    if args.fields is None:
        try:
            if len(args.request_json.encode('utf-8')) > 65536:
                raise ValueError('request too large')
            def unique_object(pairs):
                result = {}
                for key, value in pairs:
                    if key in result:
                        raise ValueError('duplicate field')
                    result[key] = value
                return result
            data = json.loads(args.request_json, object_pairs_hook=unique_object)
            allowed = {'reference'} if args.verb == 'lookup' else {'reference', 'expectedRevision', 'action', 'route'}
            if not isinstance(data, dict) or set(data) - allowed or 'reference' not in data:
                raise ValueError('invalid route request')
        except (ValueError, UnicodeError):
            parser.error('路由请求必须是有界JSON对象，不能传入身份、凭据或执行控制字段')
    else:
        data = {field:getattr(args,field) for field in args.fields}
    exchange(args.resource, args.verb, data)
