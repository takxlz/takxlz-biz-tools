# tsv-filter

TSV から、指定した列の値が指定文字列と一致する行を除外する汎用フィルタ。

## 使い方

```
node tsv-filter.js <列> <除外する値> [入力TSV] [options]
```

- `<列>` … ヘッダー名、または 1 始まりの列番号（ヘッダー名を優先。`cut`/`awk` と同じ流儀）
- `<除外する値>` … その列がこの値の行を除外（列の値は前後空白をトリムして完全一致で比較）
- `[入力TSV]` … 省略 または `-` で標準入力から読む
- `-o`, `--out <file>` … 結果をファイルへ書き出す（**指定時は標準出力に出さない**）
- `-q`, `--quiet` … 標準エラーへのサマリを抑制する
- `-h`, `--help` … 使い方を表示

```sh
# 種別列が「一致率(1.0)」の行を除外（結果は標準出力）
node tools/tsv-filter/tsv-filter.js 種別 '一致率(1.0)' input.tsv > output.tsv

# 列番号(1始まり。3列目=種別)でも指定可。標準入力からも読める
cat input.tsv | node tools/tsv-filter/tsv-filter.js 3 '一致率(1.0)' > output.tsv

# --out でファイルへ（標準出力は沈黙。トークン節約・Git Bash 安全）
node tools/tsv-filter/tsv-filter.js 種別 '一致率(1.0)' input.tsv --out output.tsv
```

## 出力先と標準エラーのサマリ

- **データ**は標準出力（既定）または `--out` のファイルへ。**両方には出さない**（`--out` 指定時は標準出力を沈黙させる）。
- **件数サマリ**を標準エラーへ1行出す（`-q` で抑制）。データには混ざらないのでパイプ合成を壊さない。

```
tsv-filter: 読込 1000 行 → 出力 850 行（除外 150: 種別=X）→ output.tsv
```

読込・出力・除外はデータ行の件数（ヘッダー・空行は数えない）。

## 仕様

- ヘッダー行は常に保持する。
- 改行は LF / CRLF 両対応。空行はスキップ。
- 指定列が見つからない場合はエラー終了（exit 1）。

## 軽量な代替（awk）

使い捨て・巨大ファイル（数百万行〜）なら `awk` のほうが省メモリ・高速。
Git Bash (Git for Windows) でも使える。

```sh
# 列番号指定（awk も Node 版も 1 始まり。3列目 = 種別）
awk -F'\t' 'NR==1 || $3 != "一致率(1.0)"' input.tsv

# 列「名」で指定（ヘッダーから列番号を解決）
awk -F'\t' 'NR==1{for(i=1;i<=NF;i++) if($i=="種別") c=i; print; next} $c!="一致率(1.0)"' input.tsv
```

Node 版と完全に同じ挙動にするには注意点がある。

- **CRLF**: Windows のTSVは行末に `\r` が残り比較が崩れる。先頭に `{sub(/\r$/,"")}` を足す。
- **前後空白トリム**: 値をトリムして比較するなら `gsub(/^[ \t]+|[ \t]+$/,"",$c)` を加える。
- **列番号**: awk・Node 版とも 1 始まりで一致。
- **awk 実装差**: gawk / mawk / BSD awk で細部が異なる。移植時は要確認。

```sh
# CRLF・トリム対応版（列名指定）
awk -F'\t' '{sub(/\r$/,"")} NR==1{for(i=1;i<=NF;i++) if($i=="種別") c=i; print; next} {v=$c; gsub(/^[ \t]+|[ \t]+$/,"",v)} v!="一致率(1.0)"' input.tsv
```

## テスト

```sh
node --test tools/tsv-filter/tsv-filter.test.js
```
