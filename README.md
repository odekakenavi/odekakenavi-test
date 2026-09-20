# 実体験データ（「📸 実際に行ったよ」）

施設基本データ（index.html 内の SPOTS）とは完全に分離した、実体験・写真のデータ置き場です。

## ファイル構成
- `index.json` … 実体験がある施設の目次（`tools/build-experience-index.js` で自動生成）
- `<facilityId>.json` … 1施設分。例: `tokyo/taito/ueno.json`（facilityId = 施設ページURLのスラッグ）
- `photos/` … 写真本体（置き場所は自由。外部ストレージ/CDNの https:// URL をそのまま書いてもよい）
- `_template.json` … 記入用の雛形（公開・読み込み対象外）

## 1施設ファイルの形式
`{ "facilityId": "...", "experiences": [ 記録, 記録, ... ] }`
1施設に複数回分の記録を並べられます（表示は訪問日の新しい順）。

## 記録の項目（固定仕様）
| 項目 | 内容 |
|---|---|
| `id` | 記録ID（施設内で一意） |
| `facilityId` | 施設ID（ファイルのfacilityIdと同じ） |
| `status` | `published`＝掲載 / `pending`＝確認待ち / `hidden`＝非掲載。**publishedのみ表示** |
| `visitDate` | 訪問日 `YYYY-MM` または `YYYY-MM-DD` |
| `party` | `adults`（大人の人数）, `children`（子どもの人数）, `childAges`（例 `["3歳","6歳"]`） |
| `transport` | `car` / `train` / `bus` / `bicycle` / `walk` / `other` |
| `stayMinutes` | 滞在時間（分） |
| `costs` | `adult` `child` `parking` `other` `total`（すべて円・数値。未入力の項目は省略可） |
| `kids` | `stroller` `toddlerFun`（0〜5歳程度） `elementaryFun`（小学生） `meals` `diaperChange` `nursing` `restBreak`。各 `{ "level": "easy"｜"partial"｜"hard", "note": "自由記述" }` |
| `learned` | 行ってみて分かったこと（自由記述） |
| `photos` | `[{ "url", "category", "caption" }]`。categoryは下記 |
| `meta` | `submittedAt` `reviewedAt` `source`（`form`/`manual`）。運営用で画面には表示しない |

写真カテゴリー: `entrance`（外観・入口）/ `parking`（駐車場）/ `play`（子どもが遊ぶ場所）/ `meal_rest`（食事・休憩）/ `other`（その他）
写真URL: `https://` の絶対URL、または `photos/` からの相対パス（例 `ueno/2026-09-a/entrance.jpg`）。

星評価・総合点・ランキング・おすすめ度に当たる項目は、仕様として持ちません。

## 追加手順
1. `_template.json` をコピーして `experiences/<facilityId>.json` を作る（既にあれば `experiences` 配列に追記）
2. 確認できたら `status` を `published` に変更
3. `node tools/build-experience-index.js` を実行（検証＋`index.json`更新）
4. 変更ファイルをGitHubへアップロード
削除は該当記録を消す（または `hidden` にする）→ 手順3。

## 外部CDNの写真を使う場合
index.html の CSP（`img-src`）は現在 `'self' data:` のみです。外部の https 画像を使うときは、そのドメインを `img-src` に追加してください。同じサイト内（`photos/`）に置く場合は変更不要です。
