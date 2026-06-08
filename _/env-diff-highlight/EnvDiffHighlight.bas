Attribute VB_Name = "EnvDiffHighlight"
Option Explicit

' ============================================================
' EnvDiffHighlight
' TSV( file / key / 種別 / env1..envN / description )を扱う Excel マクロ群。
'
' 公開マクロ:
'   ColorEnvDiff       … アクティブシートの env 列を値の種類ごとに色分け
'   ImportTsv          … TSV を全列文字列・UTF-8 で新規ブックに取り込む
'   ImportTsvAndColor  … 取り込み → 色分けまで一括実行
'
' --- 色分けについて ---
' 各行の env 列を「値の種類ごと」に色分けする。
'
' 配色ルール（1行ごとに独立して判定）:
'   1. env セルを値でグループ化する（空セルも1つの値として扱う）。
'   2. グループを「出現数の多い順 → 同数なら登場 env が早い順」で並べる。
'   3. 先頭グループ（＝最頻値＝基準）は塗らない（白）。
'   4. 残りのグループに、出現数の多い順でパレット色を割り当てる。
'
' 同じ行内で同じ値＝同じ色になるため、
'   ・1環境だけ色が違う  → 外れ値
'   ・揃うはずの環境で色境界が崩れている → 構造的な差分
' といった違和感に目視で気づける。
'
' 注意: 色の意味は行ごとに独立している（行をまたいだ同色は無関係）。
' ============================================================

Private Const HEADER_ROW As Long = 1

' エントリポイント。ActiveSheet 全体を処理する。
Sub ColorEnvDiff()
    Dim ws As Worksheet
    Set ws = ActiveSheet

    ' --- env 列の範囲を特定（種別の次 〜 description の手前） ---
    Dim kindCol As Long, descCol As Long
    kindCol = FindHeaderColumn(ws, "種別")
    descCol = FindHeaderColumn(ws, "description")

    If kindCol = 0 Then
        MsgBox "ヘッダー行（" & HEADER_ROW & " 行目）に「種別」列が見つかりません。", vbExclamation
        Exit Sub
    End If

    Dim envFirst As Long, envLast As Long
    envFirst = kindCol + 1
    If descCol > 0 Then
        envLast = descCol - 1
    Else
        ' description 列が無ければ、種別の右側の最終列までを env とみなす
        envLast = ws.Cells(HEADER_ROW, ws.Columns.Count).End(xlToLeft).Column
    End If

    If envLast < envFirst Then
        MsgBox "env 列が見つかりません（種別と description の間に列がありません）。", vbExclamation
        Exit Sub
    End If

    ' --- データ行の範囲（種別列の最終データ行まで） ---
    Dim lastRow As Long
    lastRow = ws.Cells(ws.Rows.Count, kindCol).End(xlUp).Row
    If lastRow <= HEADER_ROW Then
        MsgBox "データ行がありません。", vbExclamation
        Exit Sub
    End If

    Dim palette() As Long
    palette = BuildPalette()

    Application.ScreenUpdating = False

    Dim r As Long
    For r = HEADER_ROW + 1 To lastRow
        ColorOneRow ws, r, envFirst, envLast, palette
    Next r

    Application.ScreenUpdating = True

    MsgBox "完了: " & (lastRow - HEADER_ROW) & " 行を処理しました" & _
           "（env 列 " & (envLast - envFirst + 1) & " 列）。", vbInformation
End Sub

' TSV ファイルを選択し、全列を文字列として新規ブックに取り込む。
' 取り込みのみ（色分けは行わない）。
Sub ImportTsv()
    Dim filePath As String
    If Not PickTsvFile(filePath) Then Exit Sub ' キャンセル
    OpenTsvAsText filePath
End Sub

' TSV ファイルを取り込み、そのまま env 列の色分けまで実行する。
Sub ImportTsvAndColor()
    Dim filePath As String
    If Not PickTsvFile(filePath) Then Exit Sub ' キャンセル
    OpenTsvAsText filePath
    ColorEnvDiff
End Sub

' TSV ファイル選択ダイアログを表示する。
' @param outPath 選択されたパスを受け取る（参照渡し）
' @returns 選択されたら True、キャンセルなら False
Private Function PickTsvFile(ByRef outPath As String) As Boolean
    Dim picked As Variant
    picked = Application.GetOpenFilename( _
        FileFilter:="TSV/テキスト (*.tsv;*.txt;*.tab),*.tsv;*.txt;*.tab", _
        Title:="取り込む TSV を選択")
    If VarType(picked) = vbBoolean Then
        PickTsvFile = False ' キャンセル時は False が返る
    Else
        outPath = CStr(picked)
        PickTsvFile = True
    End If
End Function

' TSV を全列文字列・UTF-8 として新規ブックに開く。
' 全列を xlTextFormat にすることで、先頭ゼロ・日付・真偽値などの
' 自動型変換を防ぎ、差分比較が崩れないようにする。
' @param filePath 取り込む TSV のパス
Private Sub OpenTsvAsText(filePath As String)
    Dim colCount As Long
    colCount = CountColumns(filePath)
    If colCount < 1 Then
        MsgBox "ファイルが空、または読み取れません。", vbExclamation
        Exit Sub
    End If

    ' 全列を文字列(xlTextFormat=2)で取り込む FieldInfo を構築
    Dim fieldInfo() As Variant
    ReDim fieldInfo(1 To colCount)
    Dim i As Long
    For i = 1 To colCount
        fieldInfo(i) = Array(i, 2) ' 2 = xlTextFormat
    Next i

    ' Origin:=65001 で UTF-8 として解釈、タブ区切りで分割
    Workbooks.OpenText _
        Filename:=filePath, _
        Origin:=65001, _
        StartRow:=1, _
        DataType:=xlDelimited, _
        Tab:=True, Semicolon:=False, Comma:=False, Space:=False, Other:=False, _
        FieldInfo:=fieldInfo, _
        TrailingMinusNumbers:=True
End Sub

' 先頭行のタブ数 + 1 で列数を数える。
' タブ(0x09)は UTF-8 マルチバイト列と衝突しないため、
' 文字エンコーディングの影響を受けずに列数を確定できる。
' @param filePath 対象 TSV のパス
' @returns 列数。空ファイル等で読めなければ 0。
Private Function CountColumns(filePath As String) As Long
    Dim fileNum As Integer, firstLine As String
    fileNum = FreeFile
    Open filePath For Input As #fileNum
    If Not EOF(fileNum) Then Line Input #fileNum, firstLine
    Close #fileNum

    If Len(firstLine) = 0 Then
        CountColumns = 0
        Exit Function
    End If

    Dim tabs As Long, p As Long
    tabs = 0
    p = InStr(1, firstLine, vbTab)
    Do While p > 0
        tabs = tabs + 1
        p = InStr(p + 1, firstLine, vbTab)
    Loop

    CountColumns = tabs + 1
End Function

' 1行分の env セルを色分けする。
' @param ws       対象シート
' @param r        行番号
' @param envFirst env 列の先頭列番号
' @param envLast  env 列の末尾列番号
' @param palette  白を除く塗り色（出現数の多い順に割り当てる）
Private Sub ColorOneRow(ws As Worksheet, r As Long, envFirst As Long, envLast As Long, palette() As Long)
    Dim n As Long
    n = envLast - envFirst + 1

    ' --- 値ごとに出現数(count)と初出列(firstIdx)を集計 ---
    Dim keys() As String, counts() As Long, firstIdx() As Long
    ReDim keys(1 To n)
    ReDim counts(1 To n)
    ReDim firstIdx(1 To n)
    Dim groupCount As Long
    groupCount = 0

    Dim i As Long, c As Long, v As String, gi As Long
    For c = envFirst To envLast
        v = CStr(ws.Cells(r, c).Value) ' 空セルは "" として1つの値になる
        gi = 0
        For i = 1 To groupCount
            If keys(i) = v Then gi = i: Exit For
        Next i
        If gi = 0 Then
            groupCount = groupCount + 1
            keys(groupCount) = v
            counts(groupCount) = 1
            firstIdx(groupCount) = c
        Else
            counts(gi) = counts(gi) + 1
        End If
    Next c

    ' --- 「count 降順 → firstIdx 昇順」で並べ替え（選択ソート） ---
    Dim order() As Long
    ReDim order(1 To groupCount)
    For i = 1 To groupCount
        order(i) = i
    Next i

    Dim a As Long, b As Long, tmp As Long
    For a = 1 To groupCount - 1
        For b = a + 1 To groupCount
            If counts(order(b)) > counts(order(a)) Or _
               (counts(order(b)) = counts(order(a)) And firstIdx(order(b)) < firstIdx(order(a))) Then
                tmp = order(a): order(a) = order(b): order(b) = tmp
            End If
        Next b
    Next a

    ' --- 各値グループへ色を割り当て（先頭＝基準＝塗らない） ---
    ' colorOf(groupIndex): -1 = 塗らない / それ以外 = RGB 値
    Dim colorOf() As Long
    ReDim colorOf(1 To groupCount)
    Dim paletteSize As Long
    paletteSize = UBound(palette) - LBound(palette) + 1

    Dim rank As Long, g As Long
    For rank = 1 To groupCount
        g = order(rank)
        If rank = 1 Then
            colorOf(g) = -1 ' 最頻値（基準）は白
        Else
            ' パレットを超えたら循環（env10 想定では発生しないが保険）
            colorOf(g) = palette(LBound(palette) + ((rank - 2) Mod paletteSize))
        End If
    Next rank

    ' --- セルへ適用（毎回全 env セルを再設定するので再実行しても安全） ---
    For c = envFirst To envLast
        v = CStr(ws.Cells(r, c).Value)
        For i = 1 To groupCount
            If keys(i) = v Then
                If colorOf(i) = -1 Then
                    ws.Cells(r, c).Interior.Pattern = xlNone
                Else
                    ws.Cells(r, c).Interior.Color = colorOf(i)
                End If
                Exit For
            End If
        Next i
    Next c
End Sub

' ヘッダー行から見出し文字に一致する列番号を返す。
' @param ws         対象シート
' @param headerText 探す見出し文字（前後空白は無視）
' @returns 一致した列番号。見つからなければ 0。
Private Function FindHeaderColumn(ws As Worksheet, headerText As String) As Long
    Dim lastCol As Long, c As Long
    lastCol = ws.Cells(HEADER_ROW, ws.Columns.Count).End(xlToLeft).Column
    For c = 1 To lastCol
        If Trim$(CStr(ws.Cells(HEADER_ROW, c).Value)) = headerText Then
            FindHeaderColumn = c
            Exit Function
        End If
    Next c
    FindHeaderColumn = 0
End Function

' 白を除く塗り色のパレット（黒文字が読める淡色）。
' 出現数の多い順（2番目に多い値→3番目→…）に割り当てる。
' @returns RGB 値の配列（1〜9）
Private Function BuildPalette() As Long()
    Dim p() As Long
    ReDim p(1 To 9)
    p(1) = RGB(255, 255, 153) ' 黄
    p(2) = RGB(255, 204, 153) ' 橙
    p(3) = RGB(204, 255, 204) ' 緑
    p(4) = RGB(204, 255, 255) ' 水色
    p(5) = RGB(255, 204, 255) ' ピンク
    p(6) = RGB(224, 204, 255) ' 紫
    p(7) = RGB(255, 204, 204) ' 赤
    p(8) = RGB(230, 255, 153) ' 黄緑
    p(9) = RGB(217, 217, 217) ' グレー
    BuildPalette = p
End Function
