Attribute VB_Name = "modCNCWebCopy"
Option Explicit
' =====================================================================================
' CNC 가공일정 수립(HTML) 연계용 - 시트 묶음 복사
' - 통합문서의 기준 시트를 한 번에 클립보드로 복사한다. 통합문서 내용은 바꾸지 않는다.
' - 셀의 실제 값(Value2)을 보내므로 날짜는 일련번호, 호기는 숫자 그대로 간다
'   (날짜 서식이 걸린 설비1~A 칸이 "05월 10일"로 바뀌는 문제 없음).
' - 사용: CNC_WebCopy_All (기준 전체) 처음 한 번·마스터 변경 시 / CNC_WebCopy_Daily (매일: 1_원본 + 9번)
'   개발 도구 > 매크로(Alt+F8)에서 실행하거나 버튼에 연결
'   → CNC 가공일정 수립 화면 [시트 붙여넣기]에 Ctrl+V → [이 시트 반영]
' - Office 2010 이상(VBA7, 32/64비트). 참조 추가 불필요.
' =====================================================================================

Private Declare PtrSafe Function OpenClipboard Lib "user32" (ByVal hwnd As LongPtr) As Long
Private Declare PtrSafe Function EmptyClipboard Lib "user32" () As Long
Private Declare PtrSafe Function CloseClipboard Lib "user32" () As Long
Private Declare PtrSafe Function SetClipboardData Lib "user32" (ByVal wFormat As Long, ByVal hMem As LongPtr) As LongPtr
Private Declare PtrSafe Function GlobalAlloc Lib "kernel32" (ByVal wFlags As Long, ByVal dwBytes As LongPtr) As LongPtr
Private Declare PtrSafe Function GlobalLock Lib "kernel32" (ByVal hMem As LongPtr) As LongPtr
Private Declare PtrSafe Function GlobalUnlock Lib "kernel32" (ByVal hMem As LongPtr) As Long
Private Declare PtrSafe Function GlobalFree Lib "kernel32" (ByVal hMem As LongPtr) As LongPtr
Private Declare PtrSafe Sub CopyMemory Lib "kernel32" Alias "RtlMoveMemory" (ByVal dest As LongPtr, ByVal src As LongPtr, ByVal length As LongPtr)

Private Const GMEM_MOVEABLE As Long = &H2
Private Const GMEM_ZEROINIT As Long = &H40
Private Const CF_UNICODETEXT As Long = 13
Private Const BUNDLE_MARK As String = "##CNC_SHEET"

' 처음 한 번, 또는 방·설비·분류·생산성·작업자·휴일 마스터를 바꾼 뒤
Public Sub CNC_WebCopy_All()
    CopySheetsForWeb Array("원본붙여넣기", "설비배정_확정", "방마스터", "설비마스터", "생산성분류", _
                           "생산성기준", "작업자운영마스터", "BG전용기준", "BD규격마스터", _
                           "휴일마스터", "재질호기제외")
End Sub

' 매일: 일정관리 프로그램 원본(1번)과 9번 확정
Public Sub CNC_WebCopy_Daily()
    CopySheetsForWeb Array("원본붙여넣기", "설비배정_확정")
End Sub

Private Sub CopySheetsForWeb(ByVal bases As Variant)
    Dim parts() As String, n As Long, i As Long, ws As Worksheet
    Dim missing As String, summary As String, rowsN As Long
    ReDim parts(0 To UBound(bases))
    Application.StatusBar = "CNC 웹용 시트 복사 중..."
    For i = LBound(bases) To UBound(bases)
        Set ws = FindSheetByBase(CStr(bases(i)))
        If ws Is Nothing Then
            missing = missing & vbCrLf & "  - " & CStr(bases(i))
        Else
            parts(n) = BUNDLE_MARK & vbTab & ws.Name & vbLf & SheetText(ws, rowsN)
            summary = summary & vbCrLf & "  " & ws.Name & " : " & Format$(rowsN, "#,##0") & "행"
            n = n + 1
        End If
    Next i
    Application.StatusBar = False
    If n = 0 Then
        MsgBox "복사할 시트를 찾지 못했습니다." & missing, vbExclamation, "CNC 웹용 복사"
        Exit Sub
    End If
    ReDim Preserve parts(0 To n - 1)
    If Not SetClipboardText(Join(parts, vbLf)) Then
        MsgBox "클립보드에 넣지 못했습니다. 다른 프로그램이 클립보드를 쓰고 있으면 잠시 후 다시 실행하세요.", _
               vbExclamation, "CNC 웹용 복사"
        Exit Sub
    End If
    MsgBox CStr(n) & "개 시트를 복사했습니다." & summary & _
           IIf(Len(missing) > 0, vbCrLf & vbCrLf & "없는 시트:" & missing, "") & vbCrLf & vbCrLf & _
           "CNC 가공일정 수립 화면 [시트 붙여넣기]에 Ctrl+V → [이 시트 반영]", _
           vbInformation, "CNC 웹용 복사"
End Sub

' 시트 이름이 기준 이름과 같거나 "번호_기준" 또는 기준으로 끝나는 시트 (예: 4_설비마스터)
Private Function FindSheetByBase(ByVal base As String) As Worksheet
    Dim ws As Worksheet, nm As String, p As Long
    For Each ws In ThisWorkbook.Worksheets
        nm = ws.Name
        p = InStr(1, nm, "_")
        If nm = base Then Set FindSheetByBase = ws: Exit Function
        If p > 0 Then
            If Mid$(nm, p + 1) = base And IsNumeric(Left$(nm, p - 1)) Then Set FindSheetByBase = ws: Exit Function
        End If
    Next ws
    For Each ws In ThisWorkbook.Worksheets
        If Len(ws.Name) >= Len(base) Then
            If Right$(ws.Name, Len(base)) = base Then Set FindSheetByBase = ws: Exit Function
        End If
    Next ws
End Function

' A1부터 마지막 값이 있는 칸까지를 탭 구분 텍스트로 (값이 탭·줄바꿈·따옴표를 품으면 "..."로 감쌈)
Private Function SheetText(ByVal ws As Worksheet, ByRef rowsN As Long) As String
    Dim lastR As Long, lastC As Long, r As Long, c As Long
    Dim f As Range, v As Variant, lines() As String, cells() As String
    rowsN = 0
    Set f = ws.Cells.Find(What:="*", LookIn:=xlFormulas, SearchOrder:=xlByRows, SearchDirection:=xlPrevious)
    If f Is Nothing Then Exit Function
    lastR = f.Row
    Set f = ws.Cells.Find(What:="*", LookIn:=xlFormulas, SearchOrder:=xlByColumns, SearchDirection:=xlPrevious)
    lastC = f.Column
    If lastR = 1 And lastC = 1 Then
        SheetText = CellText(ws.Range("A1").Value2)
        rowsN = 1
        Exit Function
    End If
    v = ws.Range(ws.Cells(1, 1), ws.Cells(lastR, lastC)).Value2
    ReDim lines(1 To lastR)
    ReDim cells(1 To lastC)
    For r = 1 To lastR
        For c = 1 To lastC
            cells(c) = CellText(v(r, c))
        Next c
        lines(r) = Join(cells, vbTab)
    Next r
    rowsN = lastR - 1
    SheetText = Join(lines, vbLf)
End Function

Private Function CellText(ByVal x As Variant) As String
    Dim s As String
    If IsError(x) Or IsEmpty(x) Then Exit Function
    If VarType(x) = vbDouble Or VarType(x) = vbCurrency Or VarType(x) = vbLong Or VarType(x) = vbInteger Then
        ' 소수점은 항상 "." (지역 설정과 무관)
        s = Replace(CStr(x), Application.International(xlDecimalSeparator), ".")
    ElseIf VarType(x) = vbBoolean Then
        s = IIf(x, "TRUE", "FALSE")
    Else
        s = CStr(x)
    End If
    If InStr(s, vbTab) > 0 Or InStr(s, vbLf) > 0 Or InStr(s, vbCr) > 0 Or InStr(s, """") > 0 Then
        s = """" & Replace(s, """", """""") & """"
    End If
    CellText = s
End Function

Private Function SetClipboardText(ByVal s As String) As Boolean
    Dim hMem As LongPtr, p As LongPtr, bytes As LongPtr
    bytes = (Len(s) + 1) * 2
    hMem = GlobalAlloc(GMEM_MOVEABLE Or GMEM_ZEROINIT, bytes) ' 끝의 NUL 문자는 0으로 채워진 메모리가 담당
    If hMem = 0 Then Exit Function
    p = GlobalLock(hMem)
    If p = 0 Then
        GlobalFree hMem
        Exit Function
    End If
    If Len(s) > 0 Then CopyMemory p, StrPtr(s), bytes - 2
    GlobalUnlock hMem
    If OpenClipboard(0) = 0 Then
        GlobalFree hMem
        Exit Function
    End If
    EmptyClipboard
    If SetClipboardData(CF_UNICODETEXT, hMem) <> 0 Then
        SetClipboardText = True
    Else
        GlobalFree hMem
    End If
    CloseClipboard
End Function
