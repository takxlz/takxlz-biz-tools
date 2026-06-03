# tsv-mark-matches

TSV の指定列（ファイルパス）が、与えたファイル名リストに**後方一致**するか検査し、
一致した行の末尾に印（`●`）の列を追加して出力する Node ツール。

判定対象の列は `--match-col` で可変。**列名・列数に依存しない**ため、任意の TSV に使える。

## 使い方

```sh
node tsv-mark-matches.js <入力TSV|-> <ファイル名リスト> [options]
```

- `<入力TSV|->` … 入力TSV のパス。`-` で標準入力から読む
- `<ファイル名リスト>` … 1行1ファイル名のテキスト
- `-c`, `--match-col <名前\|番号>` … マッチ対象列（既定は最左列）
- `-o`, `--out <file>` … 結果をファイルへ書き出す（**指定時は標準出力に出さない**）
- `-q`, `--quiet` … 標準エラーへのサマリを抑制する
- `-h`, `--help` … 使い方を表示

```sh
# 最左列で判定（結果は標準出力）
node tsv-mark-matches.js properties.tsv filelist.txt > marked.tsv

# 先頭の file 列で判定（ヘッダ名 / 列番号 / 短縮形）
node tsv-mark-matches.js properties.tsv filelist.txt --match-col file > marked.tsv
node tsv-mark-matches.js properties.tsv filelist.txt --match-col 1    > marked.tsv
node tsv-mark-matches.js properties.tsv filelist.txt -c file          > marked.tsv

# --out でファイルへ（標準出力は沈黙。トークン節約・Git Bash 安全）
node tsv-mark-matches.js properties.tsv filelist.txt -c file --out marked.tsv

# 標準入力から読む（- を入力TSVに指定）
cat properties.tsv | node tsv-mark-matches.js - filelist.txt -c file > marked.tsv
```

## 入力

### 入力 TSV

タブ区切り。1 行目はヘッダ。判定に使う列以外は読み飛ばし、内容はそのまま保持する。
例（`tsv-to-properties` と同じ形）:

```
file    key    種別    <env名1>    <env名2>    ...    <env名N>    description
```

この例で先頭の `file` 列を突き合わせたい場合は `--match-col file`（または `--match-col 1`）。

### ファイル名リスト

1 行 1 ファイル名のプレーンテキスト。前後空白はトリムし、空行は無視する。

```
app.properties
db.properties
messages.properties
```

## マッチ対象列（`--match-col`）

突き合わせる列を指定する。**ヘッダ名**でも **1 始まりの列番号**でも指定できる
（ヘッダ名一致を優先）。省略時は**最左列**を対象とする。

| 指定例              | 意味                          |
|---------------------|-------------------------------|
| `--match-col file`  | ヘッダ名 `file` の列          |
| `--match-col 1`     | 1 列目                        |
| `-c 種別`           | 短縮形。ヘッダ名 `種別` の列  |
| （指定なし）        | 最左列                        |

## 判定ルール（後方一致）

対象列パスの **basename が、リストのいずれかと完全一致**したら「一致」とする。

- パス区切りは `/` と `\`（Windows）の両方に対応する。
- 対象列の前後空白は無視する。
- **部分一致では拾わない**: `src/myapp.properties` は `app.properties` に一致しない。
- 大文字・小文字は区別する。

## 出力

- 元の列はそのまま保持し、**最右**に新規列を 1 つ追加する。
- 追加列のヘッダ名は既定で `match`。一致行は `●`、非一致行は空セル（列数を揃える）。
- 結果はタブ区切りで標準出力（既定）または `--out` のファイルへ。改行は LF に正規化する。

### 出力先と標準エラーのサマリ

- **データ**は標準出力（既定）または `--out` のファイルへ。**両方には出さない**（`--out` 指定時は標準出力を沈黙させる）。
- **件数サマリ**を標準エラーへ1行出す（`-q` で抑制）。

```
tsv-mark-matches: 読込 1000 行 → 一致 42 行 → marked.tsv
```

読込はデータ行の件数（ヘッダ・空行は数えない）、一致は印が付いた行数。

## テスト

```sh
node --test "tools/tsv-mark-matches/*.test.js"
```

## メモ

- 追加依存なし（Node 標準のみ）。
- CLI は大きめの入力を想定し、`readline` で 1 行ずつ処理する（全行をメモリに展開しない）。
- 追加列のヘッダ名（既定 `match`）と印（既定 `●`）は、`markMatches` /
  `markMatchesStream` の `options`（`columnHeader` / `mark`）で変更できる。
