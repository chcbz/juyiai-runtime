"""Query the execution-bound position skill version resource. Never acquire credentials."""
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
