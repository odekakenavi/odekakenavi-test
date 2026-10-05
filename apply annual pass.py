#!/usr/bin/env python3
"""使い方: python3 apply_annual_pass.py data/spots.json annual_pass_data.json
spots.json の施設(name一致)に annualPass を追加して上書き保存します。
- 見つからない施設名は一覧表示するだけで、何も作りません。
- 既存の annualPass は上書きします。他の項目は変更しません。
- 元のファイルは spots.json.bak に退避します。"""
import json, shutil, sys

spots_path, data_path = sys.argv[1], sys.argv[2]
raw = json.load(open(spots_path, encoding="utf-8"))
data = {k: v for k, v in json.load(open(data_path, encoding="utf-8")).items() if not k.startswith("_")}

# spots.json が「配列」でも {"spots":[...]} でも動くようにする
spots = raw if isinstance(raw, list) else raw.get("spots")
if not isinstance(spots, list):
    sys.exit("spots.json の形式が想定と違います（配列か {\"spots\": [...]} のみ対応）。")

by_name = {}
for s in spots:
    by_name.setdefault(s.get("name"), []).append(s)

done, missing = [], []
for name, ap in data.items():
    hits = by_name.get(name)
    if not hits:
        missing.append(name); continue
    for s in hits:
        s["annualPass"] = ap
    done.append(f"{name}（{len(hits)}件）")

shutil.copyfile(spots_path, spots_path + ".bak")
json.dump(raw, open(spots_path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print("追加:", "、".join(done) or "なし")
print("見つからない施設名:", "、".join(missing) or "なし")
