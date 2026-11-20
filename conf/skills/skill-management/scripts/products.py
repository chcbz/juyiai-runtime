"""Use the current installation's execution socket; arguments never carry platform credentials."""
import argparse
import json
import sys
from position_version import exchange

COMMANDS = {
    'list': ('skill-products', 'lookup'), 'read': ('skill-products', 'lookup'),
    'files': ('skill-package-files', 'lookup'), 'metadata': ('skill-product-metadata', 'commit'),
    'retire': ('skill-product-retirements', 'commit'), 'publish': ('skill-product-versions', 'commit'),
}
if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='从标准输入读入本次请求的 JSON 对象')
    parser.add_argument('operation', choices=COMMANDS)
    parser.add_argument('--receipt', action='store_true', help='仅查询同一操作的回执，不执行写入')
    args = parser.parse_args()
    resource, verb = COMMANDS[args.operation]
    if args.receipt and verb != 'commit':
        parser.error('只读操作没有提交回执')
    data = json.load(sys.stdin)
    if not isinstance(data, dict):
        parser.error('需要 JSON 对象')
    exchange(resource, 'receipt' if args.receipt else verb, {'payload': data})
