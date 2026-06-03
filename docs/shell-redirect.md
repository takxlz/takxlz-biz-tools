# シェルのストリーム・パイプ・リダイレクト メモ

自分用リファレンス。シェル側のリダイレクト・合成の挙動を整理する。
ツール側の入出力契約（stdin=主入力 / stdout=データ / stderr=メタ、`--out`・`-q`）は
[CLAUDE.md](../CLAUDE.md) の「出力の既定方針」を参照。

シェル演算子とツール側の出力先の対応：

| 記法          | 動作                                                                       |
| ------------- | -------------------------------------------------------------------------- |
| `A \| B`      | A の stdout を B の stdin へ繋ぐ（チェーン）                               |
| `> file`      | stdout をファイルへ（上書き）。**Windows Git Bash で空になることがある**   |
| `>> file`     | stdout をファイルへ（追記）                                                |
| `2> file`     | stderr をファイルへ                                                        |
| `2>&1`        | stderr を「今の stdout の向き先」へ合流（単体ではファイル名を取らない）    |
| `> file 2>&1` | stdout と stderr を**両方** file へ。順序が逆の `2>&1 > file` は合流しない |
| `< file`      | stdin をファイルから供給                                                   |
| `-` / 省略    | （ツール規約）入力指定が `-` か省略なら stdin から読む                     |
| `--out file`  | （ツール実装）`fs` で直接ファイルへ書く（標準出力には出さない）            |

リダイレクトは**左から順に評価**されるため、`2>&1` の位置で結果が変わる：

| 書き方             | stdout | stderr | 結果                              |
| ------------------ | ------ | ------ | --------------------------------- |
| `cmd > file 2>&1`  | file   | file   | 両方 file（正解）                 |
| `cmd 2>&1 > file`  | file   | 画面   | stderr は画面に残る（よくある罠） |
| `cmd > out 2> err` | out    | err    | 別々のファイルに分離              |
| `cmd 2>&1 \| next` | パイプ | パイプ | 両方を次コマンドの stdin へ       |

`> file 2>&1`: ①stdout を file へ → ②stderr を「今の stdout＝file」へ ⇒ 両方 file。
`2>&1 > file`: ①stderr を「今の stdout＝画面」へ → ②stdout を file へ ⇒ stderr は画面のまま。

合成時の注意：途中段で `--out` するとそこで stdout が止まり後段へ渡らない（最終段だけ `--out` にする）。
`--out` は Node 標準ではなく各ツールが実装する独自フラグである点にも注意（`node --out` は `bad option` で弾かれる）。

例: `cat in.tsv | node tsv-filter.js 種別 X | node tsv-mark-matches.js - list.txt -c file --out result.tsv`
