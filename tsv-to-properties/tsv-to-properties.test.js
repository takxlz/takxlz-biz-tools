'use strict';

// テスト名を仕様文として読めるようにしている（入力条件 → 期待結果）。
// 各テスト本体は「準備 → 実行 → 検証(assert)」の順。非自明な意図のみコメントで補う。

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  escapeProperty,
  escapeKey,
  escapeValue,
  escapeComment,
  parseHeader,
  formatEntry,
  buildOutputPath,
  resolveEnvCell,
  generatePropertiesFiles,
} = require('./tsv-to-properties');

// ---- エスケープ: 非ASCII → \uXXXX -------------------------------------------

test('escapeProperty: 非ASCII（日本語）を大文字16進の \\uXXXX に変換する', () => {
  // あ=U+3042, ア=U+30A2
  assert.strictEqual(escapeValue('あ'), '\\u3042');
  assert.strictEqual(escapeKey('ア'), '\\u30A2');
  // ASCII はそのまま
  assert.strictEqual(escapeValue('abcABC123'), 'abcABC123');
});

test('escapeKey: キーは空白・区切り文字をすべてエスケープする', () => {
  assert.strictEqual(escapeKey('a b'), 'a\\ b'); // 途中の空白も
  assert.strictEqual(escapeKey('a=b'), 'a\\=b');
  assert.strictEqual(escapeKey('a:b'), 'a\\:b');
  assert.strictEqual(escapeKey('#x'), '\\#x');
  assert.strictEqual(escapeKey('!x'), '\\!x');
  assert.strictEqual(escapeKey('a\\b'), 'a\\\\b');
});

test('escapeValue: 値は先頭空白のみエスケープし、途中の空白は残す', () => {
  assert.strictEqual(escapeValue(' x'), '\\ x'); // 先頭空白
  assert.strictEqual(escapeValue('a b c'), 'a b c'); // 途中は素通し
  // = : # ! は値でもエスケープ対象（java.util.Properties.store 準拠）
  assert.strictEqual(escapeValue('a=b'), 'a\\=b');
  assert.strictEqual(escapeValue('http://x'), 'http\\://x');
});

test('escapeProperty: タブ・改行などの制御文字を変換する', () => {
  assert.strictEqual(escapeValue('a\tb'), 'a\\tb');
  assert.strictEqual(escapeValue('a\nb'), 'a\\nb');
  assert.strictEqual(escapeValue('a\rb'), 'a\\rb');
});

// ---- コメント ----------------------------------------------------------------

test('escapeComment: 改行を空白化し、非ASCII を \\uXXXX に変換する', () => {
  assert.strictEqual(escapeComment('説明'), '\\u8AAC\\u660E');
  assert.strictEqual(escapeComment('line1\nline2'), 'line1 line2');
});

// ---- ヘッダ解析 --------------------------------------------------------------

test('parseHeader: 種別の次〜description の前を環境名として取り出す', () => {
  const header = ['file', 'key', '種別', 'PROD', 'STG', 'DEV', 'description'].join('\t');

  const parsed = parseHeader(header);

  assert.deepStrictEqual(parsed.envNames, ['PROD', 'STG', 'DEV']);
  assert.strictEqual(parsed.envStartIndex, 3);
  assert.strictEqual(parsed.descIndex, 6);
});

test('parseHeader: 列が少なすぎる場合は例外', () => {
  assert.throws(() => parseHeader(['file', 'key', '種別', 'description'].join('\t')));
});

// ---- 1エントリの整形 --------------------------------------------------------

test('formatEntry: description があればコメント行 + key=value', () => {
  const out = formatEntry('app.name', 'サービス', '名称');

  assert.strictEqual(out, '#\\u540D\\u79F0\napp.name=\\u30B5\\u30FC\\u30D3\\u30B9\n');
});

test('formatEntry: description が空ならコメント行を出さない', () => {
  assert.strictEqual(formatEntry('a.b', 'v', ''), 'a.b=v\n');
});

test('formatEntry: 値が空でも key= を出力する', () => {
  assert.strictEqual(formatEntry('a.b', '', ''), 'a.b=\n');
});

// ---- 出力パス ----------------------------------------------------------------

test('buildOutputPath: env ディレクトリ配下に <file>.properties を作る', () => {
  assert.strictEqual(
    buildOutputPath('/out', 'PROD', 'messages'),
    path.join('/out', 'PROD', 'messages.properties')
  );
  // すでに .properties 付きならそのまま
  assert.strictEqual(
    buildOutputPath('/out', 'PROD', 'messages.properties'),
    path.join('/out', 'PROD', 'messages.properties')
  );
});

// ---- センチネル解釈 ----------------------------------------------------------

test('resolveEnvCell: <EMPTY> は空値で出力、<NOKEY>/<NOPROP> は出力しない、通常値はそのまま', () => {
  assert.deepStrictEqual(resolveEnvCell('<EMPTY>'), { emit: true, value: '' });
  // キーなし / プロパティなし はどちらも行を出さない（意図はTSV上のラベルで区別）
  assert.deepStrictEqual(resolveEnvCell('<NOKEY>'), { emit: false, value: '' });
  assert.deepStrictEqual(resolveEnvCell('<NOPROP>'), { emit: false, value: '' });
  assert.deepStrictEqual(resolveEnvCell('http://x'), { emit: true, value: 'http://x' });
});

test('resolveEnvCell: 空セルはエラー（センチネル必須）', () => {
  assert.throws(() => resolveEnvCell(''));
});

// ---- 統合テスト --------------------------------------------------------------

test('generatePropertiesFiles: <EMPTY>/<NOKEY>/<NOPROP>/通常値を env 別に出力し分ける', async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsv2prop-'));
  const inputPath = path.join(workDir, 'in.tsv');
  const outDir = path.join(workDir, 'out');

  const rows = [
    ['file', 'key', '種別', 'PROD', 'DEV', 'description'].join('\t'),
    ['messages', 'app.title', 'str', '本番タイトル', '開発タイトル', 'アプリ名'].join('\t'),
    // DEV では app.url はキー未設定なので出力しない
    ['messages', 'app.url', 'str', 'http://prod', '<NOKEY>', ''].join('\t'),
    // DEV では feature.flag はプロパティ自体が適用外なので出力しない
    ['messages', 'feature.flag', 'str', 'true', '<NOPROP>', ''].join('\t'),
    // DEV では timeout を明示的に空にする
    ['config', 'timeout', 'num', '30', '<EMPTY>', '待機秒数'].join('\t'),
  ];
  fs.writeFileSync(inputPath, rows.join('\n') + '\n', 'utf8');

  const stats = await generatePropertiesFiles(inputPath, outDir);
  assert.strictEqual(stats.rowCount, 4);
  // 生成ファイルは PROD/messages, DEV/messages, PROD/config, DEV/config の4つ（stderr サマリ用）
  assert.strictEqual(stats.fileCount, 4);

  const prodMessages = fs.readFileSync(path.join(outDir, 'PROD', 'messages.properties'), 'utf8');
  // 日本語は \uXXXX 化、URL のコロンはエスケープ、description はコメント
  assert.match(prodMessages, /#\\u30A2\\u30D7\\u30EA\\u540D/); // 「アプリ名」
  assert.match(prodMessages, /app\.title=\\u672C\\u756A/); // 「本番…」
  assert.match(prodMessages, /app\.url=http\\:\/\/prod/);

  // DEV の messages: <NOKEY>/<NOPROP> はどちらもキー自体が無い
  const devMessages = fs.readFileSync(path.join(outDir, 'DEV', 'messages.properties'), 'utf8');
  assert.match(devMessages, /app\.title=/);
  assert.doesNotMatch(devMessages, /app\.url/);
  assert.doesNotMatch(devMessages, /feature\.flag/);

  // DEV の config: timeout は <EMPTY> なので key= で出力
  const devConfig = fs.readFileSync(path.join(outDir, 'DEV', 'config.properties'), 'utf8');
  assert.match(devConfig, /timeout=\n/);

  fs.rmSync(workDir, { recursive: true, force: true });
});

test('generatePropertiesFiles: 空セルは行番号付きエラーで停止する', async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsv2prop-err-'));
  const inputPath = path.join(workDir, 'in.tsv');
  const outDir = path.join(workDir, 'out');

  const rows = [
    ['file', 'key', '種別', 'PROD', 'DEV', 'description'].join('\t'),
    ['config', 'timeout', 'num', '30', '', '待機秒数'].join('\t'), // DEV が空セル
  ];
  fs.writeFileSync(inputPath, rows.join('\n') + '\n', 'utf8');

  await assert.rejects(generatePropertiesFiles(inputPath, outDir), /2行目.*DEV/);

  fs.rmSync(workDir, { recursive: true, force: true });
});

test('generatePropertiesFiles: file 列にサブディレクトリを含む場合も中間ディレクトリを作成して出力する', async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsv2prop-subdir-'));
  const inputPath = path.join(workDir, 'in.tsv');
  const outDir = path.join(workDir, 'out');

  // file 列はファイルパスなのでサブディレクトリを含みうる（事前作成は env 直下のみ）
  const rows = [
    ['file', 'key', '種別', 'PROD', 'description'].join('\t'),
    ['config/app/messages', 'app.title', 'str', 'タイトル', 'アプリ名'].join('\t'),
  ];
  fs.writeFileSync(inputPath, rows.join('\n') + '\n', 'utf8');

  const stats = await generatePropertiesFiles(inputPath, outDir);
  assert.strictEqual(stats.rowCount, 1);

  const content = fs.readFileSync(
    path.join(outDir, 'PROD', 'config', 'app', 'messages.properties'),
    'utf8'
  );
  assert.match(content, /app\.title=/);

  fs.rmSync(workDir, { recursive: true, force: true });
});

test('escapeProperty: サロゲートペア（絵文字）を2つの \\uXXXX に分解する', () => {
  // 😀 = U+1F600 → UTF-16 では D83D DE00
  assert.strictEqual(escapeValue('😀'), '\\uD83D\\uDE00');
});

test('generatePropertiesFiles: file 種類が同時オープン上限を超えても全件出力する（LRU退避）', async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsv2prop-lru-'));
  const inputPath = path.join(workDir, 'in.tsv');
  const outDir = path.join(workDir, 'out');

  // 上限を 2 に絞り、5 種類の file を交互に書く → 退避と追記再オープンが発生する
  const lines = [['file', 'key', '種別', 'PROD', 'description'].join('\t')];
  for (let round = 0; round < 3; round++) {
    for (let fileNo = 0; fileNo < 5; fileNo++) {
      lines.push([`f${fileNo}`, `k${round}`, 's', `v${round}`, ''].join('\t'));
    }
  }
  fs.writeFileSync(inputPath, lines.join('\n') + '\n', 'utf8');

  const stats = await generatePropertiesFiles(inputPath, outDir, { maxOpenFiles: 2 });
  assert.strictEqual(stats.rowCount, 15);
  // 同時オープン上限を超えて退避されても、生成ファイル種類数は 5 と数える
  assert.strictEqual(stats.fileCount, 5);

  // 各 file は 3 ラウンド分すべて追記されている（退避で消えていない）
  for (let fileNo = 0; fileNo < 5; fileNo++) {
    const content = fs.readFileSync(path.join(outDir, 'PROD', `f${fileNo}.properties`), 'utf8');
    assert.deepStrictEqual(
      content.split('\n').filter((line) => line !== ''),
      ['k0=v0', 'k1=v1', 'k2=v2']
    );
  }

  fs.rmSync(workDir, { recursive: true, force: true });
});
