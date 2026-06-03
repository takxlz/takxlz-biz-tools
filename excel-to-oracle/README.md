# excel-to-oracle

Excel（1シートに複数テーブルのデータが縦に並んだもの）を読み取り、ローカルの
Oracle にデータを INSERT するセットアップ用ツール。動作確認・ローカル DB の初期投入を想定。

## 使い方

事前に `npm install` と接続用の環境変数（`ORA_USER` / `ORA_PASSWORD` / `ORA_CONNECT_STRING`）が
必要（詳細は[セットアップ](#セットアップ)）。

```bash
ORA_USER=scott \
ORA_PASSWORD=tiger \
ORA_CONNECT_STRING=localhost:1521/XEPDB1 \
node excel-to-oracle.js data.xlsx
```

- `<Excelファイル>` … 投入対象の `.xlsx`（[入力 Excel のフォーマット](#入力-excel-のフォーマット)参照）
- `-q`, `--quiet` … 標準エラーへの投入結果サマリを抑制する
- `-h`, `--help` … 使い方を表示

データは Oracle へ INSERT する（標準出力は使わない）。投入結果サマリ（テーブル別件数・合計）は
**標準エラー**へ出す（`-q` で抑制）。全ブロックの投入後にまとめてコミットする
（途中で失敗した場合はコミットしない）。

```
  scott.emp: 2 件
  scott.dept: 1 件
excel-to-oracle: 2 テーブル / 計 3 件 INSERT
```

## 入力 Excel のフォーマット

1シート内に、テーブルごとのブロックが縦に並ぶ。各ブロックは **空行で区切る**。
ブロックは次の3要素で構成する。

```
select * from scott.emp where deptno = 10     ← SELECT 文（テーブル名の抽出元）
id          name        body                   ← ヘッダ行（= カラム名）
1           alice       <root>...</root>        ← データ行
2           bob

select * from scott.dept                       ← 次のブロック（空行で区切る）
id          label
10          sales
```

- **テーブル名**: SELECT 文の `from` 直後の最初の識別子を採用する。`schema.table` 形式も可。
- **カラム名**: ヘッダ行のセルがそのままテーブルのカラム名になる（ヘッダ名 = カラム名）。
- **データ行**: 空行が来るまでをそのブロックのデータとする。
- SELECT 行より前にある表題などの非空行は読み飛ばす。

## 前提・制約（初版）

- **接続**: node-oracledb の Thin モード（Oracle Instant Client 不要、Oracle Database 12.1 以降）。
- **処理**: INSERT のみ（TRUNCATE / UPSERT / DDL は行わない）。再実行すると行が重複する。
- **バインド型**: 全ての値を文字列でバインドし、Oracle の暗黙変換に任せる。
  - `NUMBER` は問題なし。`DATE` はセッションの NLS 書式に依存するため、必要なら
    投入前に `ALTER SESSION SET NLS_DATE_FORMAT = ...` で書式を合わせる。
- **XMLType**: DB メタデータ（`all_tab_columns`）を照会して XMLType カラムを特定し、
  その列だけ INSERT 文で `XMLTYPE(:bind)` でラップする。32KB を超える XML の
  CLOB バインドは未対応（必要になったら拡張）。
- **executeMany の型推論**: バインド型は先頭データ行から推論される。ある列が
  先頭行で空（NULL）だと推論に失敗しうる。その場合は当該行を埋めるか、型指定の拡張が必要。
- **空セル**: NULL として INSERT する。

## セットアップ

```bash
cd tools/excel-to-oracle
npm install        # exceljs / oracledb を取得
```

接続情報は環境変数で渡す（ソースにハードコードしない）。

| 環境変数             | 説明                                                     |
|----------------------|----------------------------------------------------------|
| `ORA_USER`           | 接続ユーザー                                             |
| `ORA_PASSWORD`       | パスワード                                               |
| `ORA_CONNECT_STRING` | 接続文字列（例: `localhost:1521/XEPDB1`、TNS 名も可）    |

## テスト

DB・Excel に依存しない純関数（テーブル名抽出・ブロック分割・INSERT 文生成・
バインド変換）を Node 標準ランナーで検証する。

```bash
# リポジトリルートから
node --test "tools/excel-to-oracle/excel-to-oracle.test.js"
```

DB / Excel 依存部（`readWorkbook` / `getXmlTypeColumns` / `insertBlocks`）は
実 Oracle が必要なため、ユニットテストの対象外（手動確認）。

## 公開関数

| 関数                                  | 役割                                                      |
|---------------------------------------|-----------------------------------------------------------|
| `extractTableName(selectSql)`         | SELECT 文からテーブル名を抽出                             |
| `parseSheetBlocks(rows)`              | シート2次元配列をテーブルブロック群へ分割                |
| `buildInsertSql(table, cols, xmlCols)`| XMLType 列を `XMLTYPE()` でラップした INSERT 文を生成     |
| `toBindRow(row, columnCount)`         | データ行をバインド配列へ変換（空セルは NULL）            |
| `readWorkbook(filePath)`              | Excel 先頭シートを2次元配列で読み取り（要 exceljs）       |
| `getXmlTypeColumns(conn, table)`      | XMLType カラム名を DB メタデータから取得（要 oracledb）   |
| `insertBlocks(conn, blocks)`          | ブロックごとに executeMany で投入しコミット（要 oracledb）|
