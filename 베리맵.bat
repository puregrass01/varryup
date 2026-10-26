@echo off
chcp 65001 >nul
cd /d "%~dp0"
:MENU
cls
echo ============================================
echo  베리맵
echo ============================================
echo.
echo  [ 기준 코드표 ]
echo     1. 코드표 불러오기 + 정규화
echo.
echo  [ 쿠팡   관리자 서버 경유 ]
echo     2. 연결 확인
echo     3. 목록 전량 + 분포
echo     4. 광각미러 상세 + 재고 - 약 8분
echo.
echo  [ 스마트스토어 ]
echo     5. 목록 전량
echo     6. 자동차 광각미러 상세 전량 - 약 8분
echo.
echo  [ 아임웹 ]
echo     7. 진단 - 키가 어디 있는지 확인
echo     8. 키 입력 + 저장 - 한 번만
echo    11. 본사몰 상품목록 - 내 차 찾기 ver2 만
echo    12. B2B몰
echo    13. B2B 옵션 구조 확인 - 3건만
echo    14. B2B 옵션 조회 - 확인필요 상품만
echo    15. 본사몰 옵션 조회 - 확인필요 상품만
echo    17. 본사몰 쇼핑 카테고리 목록
echo.
echo  [ 해외몰 - 미국 / 일본 ]
echo    19. 게시판 구조 확인 - 게시판 3개만
echo    18. 게시판 등록현황 수집
echo    20. 게시물 본문 구조 확인 - 3건만
echo    22. 게시물 본문 읽기 - 확인필요분만
echo    23. 게시물 본문 읽기 - 전량 (링크용 idx 포함)
echo.
echo  [ 대조 ]
echo    21. 코드표 X 전 채널 대조 실행
echo.
echo     Q. 종료
echo.
set "SEL="
set /p SEL="번호 입력: "
echo.
if "%SEL%"=="1" goto S1
if "%SEL%"=="2" goto S2
if "%SEL%"=="3" goto S3
if "%SEL%"=="4" goto S4
if "%SEL%"=="5" goto S5
if "%SEL%"=="6" goto S6
if "%SEL%"=="7" goto S7
if "%SEL%"=="8" goto S8
if "%SEL%"=="11" goto S11
if "%SEL%"=="12" goto S12
if "%SEL%"=="13" goto S13
if "%SEL%"=="14" goto S14
if "%SEL%"=="15" goto S15
if "%SEL%"=="16" goto S16
if "%SEL%"=="17" goto S17
if "%SEL%"=="18" goto S18
if "%SEL%"=="19" goto S19
if "%SEL%"=="20" goto S20
if "%SEL%"=="22" goto S22
if "%SEL%"=="23" goto S23
if "%SEL%"=="21" goto S21
if /i "%SEL%"=="Q" goto QUIT
echo 메뉴에 있는 번호를 입력해주세요.
goto PAUSE_MENU

:S1
node scripts\verimap_load_codetable.mjs
goto PAUSE_MENU

:S2
node scripts\verimap_collect_coupang.mjs --probe
goto PAUSE_MENU

:S3
node scripts\verimap_collect_coupang.mjs
goto PAUSE_MENU

:S4
node scripts\verimap_collect_coupang.mjs --detail --stock --category=78732
goto PAUSE_MENU

:S5
call node_modules\.bin\electron.cmd scripts\verimap_collect_naver.mjs --direct
goto SHOWLOG

:S6
call node_modules\.bin\electron.cmd scripts\verimap_collect_naver.mjs --direct --category=50004061 --detail
goto SHOWLOG

:S7
node scripts\verimap_collect_imweb.mjs --diag
goto PAUSE_MENU

:S8
node scripts\verimap_collect_imweb.mjs --reset-keys
echo.
echo 입력한 키를 저장합니다. 다음부터는 묻지 않습니다.
node scripts\verimap_collect_imweb.mjs --probe --ask --no-server --save-keys
goto PAUSE_MENU

:S11
node scripts\verimap_collect_imweb.mjs --no-server --cat=내차찾기ver2
goto PAUSE_MENU

:S12
node scripts\verimap_collect_imweb.mjs --site=b2b --no-server
goto PAUSE_MENU

:S13
node scripts\verimap_collect_imweb.mjs --site=b2b --no-server --options --limit=3
goto PAUSE_MENU

:S14
node scripts\verimap_collect_imweb.mjs --site=b2b --no-server --options
goto PAUSE_MENU

:S15
node scripts\verimap_collect_imweb.mjs --no-server --options --unit=u2026012071cb0d215bc67
goto PAUSE_MENU

:S16
node scripts\verimap_collect_imweb.mjs --no-server --boards
goto PAUSE_MENU

:S17
node scripts\verimap_collect_imweb.mjs --no-server --cats
goto PAUSE_MENU

:S18
node scripts\verimap_collect_imweb_boards.mjs
goto PAUSE_MENU

:S19
node scripts\verimap_collect_imweb_boards.mjs --boards-limit=3
goto PAUSE_MENU

:S20
node scripts\verimap_collect_imweb_boards.mjs --detail --detail-limit=3
goto PAUSE_MENU

:S22
node scripts\verimap_collect_imweb_boards.mjs --detail
goto PAUSE_MENU

:S23
node scripts\verimap_collect_imweb_boards.mjs --detail-all
goto PAUSE_MENU

:S21
node scripts\verimap_match.mjs
goto PAUSE_MENU

:SHOWLOG
echo.
echo ----------- 실행 기록 -----------
if exist data\verimap\naver_log.txt type data\verimap\naver_log.txt
goto PAUSE_MENU

:PAUSE_MENU
echo.
pause
goto MENU

:QUIT
