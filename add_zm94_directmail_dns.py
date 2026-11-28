#!/usr/bin/env python3
"""为 zm94.com 的 DirectMail 发信域名 mail.zm94.com 添加 DNS 验证记录（幂等，可重复运行）。

用法：
  export ALIBABA_CLOUD_ACCESS_KEY_ID=你的AccessKeyID
  export ALIBABA_CLOUD_ACCESS_KEY_SECRET=你的AccessKeySecret
  python3 add_zm94_directmail_dns.py --dry-run   # 只打印将要添加/修改的记录
  python3 add_zm94_directmail_dns.py             # 实际添加（已存在的跳过）

说明：
  - 这 4 条记录都在 mail.zm94.com 子域下，跟主域名的钉钉邮箱解析（MX/SPF/DKIM/DMARC）互不冲突。
  - SPF 特殊处理：若 mail.zm94.com 已有别的 v=spf1 记录，会把 include:spf1.dm.aliyun.com
    合并进去而不是新增第二条 SPF（一个域名只能有一条 SPF）。
  - 建议给 RAM 子账号最小权限：alidns:DescribeDomainRecords、alidns:AddDomainRecord、
    alidns:UpdateDomainRecord。脚本不会把密钥写入任何文件，只从环境变量读取。
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
    {
        "RR": "aliyun-cn-hangzhou._domainkey.mail",
        "Type": "TXT",
        "Value": (
            "v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDH9eCbh6"
            "+JMKZnqHsHnU7/JRKySH1xLXm1qUFR5YO0EtcVrVyYCY4hgqk0Zu8Q+Wz5naTU90wSz8"
            "3XAG9OwhNDMVL/9O2JUnlsIn+c1OflGZDNTnbaWgMlB5p2nPsGeNsWzxoNESsvXSPy2KM"
            "qGQ7RhQt6fENxuafVx6H/cKRHdwIDAQAB"
        ),
    },
    {"RR": "mail", "Type": "TXT", "Value": "v=spf1 include:spf1.dm.aliyun.com -all"},
    {
        "RR": "_dmarc.mail",
        "Type": "TXT",
        "Value": "v=DMARC1;p=none;rua=mailto:dmarc_report@service.aliyun.com",
    },
    {"RR": "mail", "Type": "MX", "Value": "mx01.dm.aliyun.com", "Priority": 10},
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
        f"{percent_encode(k)}={percent_encode(params[k])}" for k in sorted(params.keys())
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


def existing_records(access_key_id: str, access_key_secret: str) -> list[dict]:
    result = call_api(
        "DescribeDomainRecords",
        access_key_id,
        access_key_secret,
        {"DomainName": DOMAIN, "PageNumber": 1, "PageSize": 100},
    )
    items = result.get("DomainRecords", {}).get("Record", [])
    if isinstance(items, dict):
        items = [items]
    return items


def merge_spf(value: str, include: str) -> str:
    """在已有 SPF 的 all 机制前插入 include，不产生第二条 SPF。"""
    v = value.strip()
    if include in v:
        return v
    for mechanism in ("-all", "~all", "+all", "?all"):
        if v.endswith(" " + mechanism):
            return v[: -len(mechanism)].rstrip() + " " + include + " " + mechanism
    return v + " " + include


def main() -> int:
    parser = argparse.ArgumentParser(description="为 zm94.com 添加 DirectMail 发信域名解析")
    parser.add_argument("--dry-run", action="store_true", help="只打印，不实际修改")
    args = parser.parse_args()

    print(f"目标发信域名: mail.{DOMAIN}")
    print("计划处理：")
    for r in RECORDS:
        priority = f" 优先级 {r['Priority']}" if "Priority" in r else ""
        print(f"  {r['RR']:<42} {r['Type']:<4} {r['Value']}{priority}")

    access_key_id = os.environ.get("ALIBABA_CLOUD_ACCESS_KEY_ID", "").strip()
    access_key_secret = os.environ.get("ALIBABA_CLOUD_ACCESS_KEY_SECRET", "").strip()
    if not access_key_id or not access_key_secret:
        if args.dry_run:
            print("\n[dry-run] 未设置密钥，未查询线上记录，仅打印计划。")
            return 0
        print(
            "\n错误：请先设置环境变量 ALIBABA_CLOUD_ACCESS_KEY_ID 和 "
            "ALIBABA_CLOUD_ACCESS_KEY_SECRET。",
            file=sys.stderr,
        )
        return 2

    try:
        items = existing_records(access_key_id, access_key_secret)
    except Exception as exc:
        print(f"查询现有解析失败：{exc}", file=sys.stderr)
        return 1

    added = skipped = updated = 0
    for r in RECORDS:
        key = (r["RR"], r["Type"], r["Value"])
        match = next(
            (
                x for x in items
                if (x.get("RR", ""), x.get("Type", ""), x.get("Value", "")) == key
            ),
            None,
        )
        if match:
            print(f"跳过（已存在）：{r['RR']} {r['Type']}")
            skipped += 1
            continue

        # SPF 特殊处理：同 RR 已有别的 v=spf1 就合并，不要新增第二条
        if r["RR"] == "mail" and r["Type"] == "TXT":
            spf = next(
                (
                    x for x in items
                    if x.get("RR") == r["RR"]
                    and x.get("Type") == "TXT"
                    and str(x.get("Value", "")).strip().startswith("v=spf1")
                ),
                None,
            )
            if spf:
                merged = merge_spf(str(spf["Value"]), "include:spf1.dm.aliyun.com")
                if merged == str(spf["Value"]):
                    print(f"跳过（SPF 已含所需 include）：{r['RR']}")
                    skipped += 1
                    continue
                if args.dry_run:
                    print(f"[dry-run] 将合并 SPF：{r['RR']} -> {merged}")
                    added += 1
                    continue
                try:
                    call_api(
                        "UpdateDomainRecord",
                        access_key_id,
                        access_key_secret,
                        {
                            "RecordId": spf["RecordId"],
                            "RR": r["RR"],
                            "Type": "TXT",
                            "Value": merged,
                        },
                    )
                except Exception as exc:
                    print(f"合并 SPF 失败：{r['RR']} -> {exc}", file=sys.stderr)
                    return 1
                print(f"已合并 SPF：{r['RR']} -> {merged}")
                updated += 1
                continue

        if args.dry_run:
            print(f"[dry-run] 将新增：{r['RR']} {r['Type']}")
            added += 1
            continue
        extra = {"DomainName": DOMAIN, "RR": r["RR"], "Type": r["Type"], "Value": r["Value"]}
        if "Priority" in r:
            extra["Priority"] = r["Priority"]
        try:
            result = call_api("AddDomainRecord", access_key_id, access_key_secret, extra)
        except Exception as exc:
            print(f"添加失败：{r['RR']} {r['Type']} -> {exc}", file=sys.stderr)
            return 1
        print(f"已添加：{r['RR']} {r['Type']} (RecordId={result.get('RecordId', '?')})")
        added += 1

    print(f"\n完成：新增 {added} 条，更新 {updated} 条，跳过 {skipped} 条。")
    print("可用以下命令验证：")
    print(f"  dig +short TXT aliyun-cn-hangzhou._domainkey.mail.{DOMAIN}")
    print(f"  dig +short TXT mail.{DOMAIN}")
    print(f"  dig +short TXT _dmarc.mail.{DOMAIN}")
    print(f"  dig +short MX mail.{DOMAIN}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
