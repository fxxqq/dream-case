#!/usr/bin/env python3
"""为 zm94.com 一键添加钉钉 MailBee 邮箱解析记录（幂等，可重复运行）。

用法：
  export ALIBABA_CLOUD_ACCESS_KEY_ID=你的AccessKeyID
  export ALIBABA_CLOUD_ACCESS_KEY_SECRET=你的AccessKeySecret
  python3 add_zm94_mail_dns.py --dry-run   # 只打印将要添加的记录
  python3 add_zm94_mail_dns.py             # 实际添加（已存在的会跳过）

建议给 RAM 子账号最小权限：alidns:DescribeDomainRecords、alidns:AddDomainRecord。
脚本不会把密钥写入任何文件，只通过环境变量读取。
"""

import argparse
import base64
import hashlib
import hmac
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone

ENDPOINT = "https://alidns.aliyuncs.com/"
DOMAIN = "zm94.com"
VERSION = "2015-01-09"

RECORDS = [
    {"RR": "@", "Type": "MX", "Value": "mx1.mailbee.dingtalk.com", "Priority": 5},
    {"RR": "@", "Type": "TXT", "Value": "v=spf1 include:spf1.mailbee.dingtalk.com -all"},
    {
        "RR": "mailbee-cn-128cf08._domainkey",
        "Type": "TXT",
        "Value": (
            "v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA"
            "keuJNQdx/JUSrwvlh0dnzxLuH/BUxvRipev1M0CcXmxbnofWmS7bjLutjzZIXaOy3NyCJ"
            "gIB/Gt/3SPAhSOBVlU+ECQitXTGdvY6oXR/uKz8+Tv6CI3/WkrAAUQqLCtHlgGL4C7k9Y"
            "6x4cDbgAgBVf2UF9LlImNf6Pv1DZUNNC+nwPY6sXN3GrqhN2xpG18688CTBBtTFbahtbm"
            "/Es7sEMKmQJdT22hD+2SBtt7YdP/O5ga1La3xRKfTgKf3exiNYjWFPJSdxGFtPo0c2pEC"
            "zfO7jAuRHh67LD3MAaXY2vO98Lg1Av2hK/x6ZJvQe3bHTr4crS+3Qs95Zrv9budWdQIDA"
            "QAB"
        ),
    },
    {
        "RR": "_dmarc",
        "Type": "TXT",
        "Value": "v=DMARC1; p=none; rua=mailto:dmarc_report@mailbee.dingtalk.com",
    },
]


def percent_encode(value: str) -> str:
    """阿里云 RPC 签名要求的 UTF-8 百分号编码（大写十六进制）。"""
    return urllib.parse.quote(str(value), safe="~")


def build_signed_params(action: str, access_key_id: str, access_key_secret: str,
                        extra: dict | None = None) -> str:
    params = {
        "Action": action,
        "AccessKeyId": access_key_id,
        "Format": "JSON",
        "Version": VERSION,
        "Timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "SignatureNonce": uuid.uuid4().hex,
        "SignatureMethod": "HMAC-SHA1",
        "SignatureVersion": "1.0",
    }
    if extra:
        params.update(extra)

    canonical = "&".join(
        f"{percent_encode(k)}={percent_encode(params[k])}"
        for k in sorted(params.keys())
    )
    string_to_sign = "GET&%2F&" + percent_encode(canonical)
    digest = hmac.new(
        (access_key_secret + "&").encode("utf-8"),
        string_to_sign.encode("utf-8"),
        hashlib.sha1,
    ).digest()
    signature = base64.b64encode(digest).decode("ascii")
    return canonical + "&Signature=" + percent_encode(signature)


def call_api(action: str, access_key_id: str, access_key_secret: str,
             extra: dict | None = None) -> dict:
    query = build_signed_params(action, access_key_id, access_key_secret, extra)
    request = urllib.request.Request(ENDPOINT + "?" + query, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"阿里云 API {action} 返回 HTTP {exc.code}: {body}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"无法连接阿里云 API: {exc}") from exc


def existing_records(access_key_id: str, access_key_secret: str) -> set:
    result = call_api(
        "DescribeDomainRecords",
        access_key_id,
        access_key_secret,
        {"DomainName": DOMAIN, "PageNumber": 1, "PageSize": 100},
    )
    items = result.get("DomainRecords", {}).get("Record", [])
    if isinstance(items, dict):
        items = [items]
    return {
        (item.get("RR", ""), item.get("Type", ""), item.get("Value", ""))
        for item in items
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="为 zm94.com 添加阿里企业邮箱解析")
    parser.add_argument("--dry-run", action="store_true", help="只打印，不实际修改")
    parser.add_argument("--domain", default=DOMAIN, help="要设置的域名（默认 zm94.com）")
    args = parser.parse_args()

    domain = args.domain
    records = RECORDS if domain == DOMAIN else [
        {**r, "Value": r["Value"]} for r in RECORDS
    ]

    print(f"目标域名: {domain}")
    print("计划添加的解析记录：")
    for r in records:
        priority = f" 优先级 {r['Priority']}" if "Priority" in r else ""
        print(f"  {r['RR']:<6} {r['Type']:<5} {r['Value']}{priority}")

    if args.dry_run:
        print("\n[dry-run] 未调用 API，未做任何修改。")
        return 0

    access_key_id = os.environ.get("ALIBABA_CLOUD_ACCESS_KEY_ID", "").strip()
    access_key_secret = os.environ.get("ALIBABA_CLOUD_ACCESS_KEY_SECRET", "").strip()
    if not access_key_id or not access_key_secret:
        print(
            "错误：请先设置环境变量 ALIBABA_CLOUD_ACCESS_KEY_ID 和 "
            "ALIBABA_CLOUD_ACCESS_KEY_SECRET。",
            file=sys.stderr,
        )
        return 2

    try:
        existing = existing_records(access_key_id, access_key_secret)
    except Exception as exc:
        print(f"查询现有解析失败：{exc}", file=sys.stderr)
        return 1

    added = 0
    skipped = 0
    for r in records:
        key = (r["RR"], r["Type"], r["Value"])
        if key in existing:
            print(f"跳过（已存在）：{r['RR']} {r['Type']} {r['Value']}")
            skipped += 1
            continue

        extra = {
            "DomainName": domain,
            "RR": r["RR"],
            "Type": r["Type"],
            "Value": r["Value"],
        }
        if "Priority" in r:
            extra["Priority"] = r["Priority"]

        try:
            result = call_api("AddDomainRecord", access_key_id, access_key_secret, extra)
        except Exception as exc:
            print(f"添加失败：{r['RR']} {r['Type']} {r['Value']} -> {exc}", file=sys.stderr)
            return 1

        print(f"已添加：{r['RR']} {r['Type']} {r['Value']} (RecordId={result.get('RecordId', '?')})")
        added += 1

    print(f"\n完成：新增 {added} 条，跳过 {skipped} 条。")
    print("可用以下命令验证 MX：")
    print(f"  dig +short MX {domain}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
