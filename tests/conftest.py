"""pytest 부트스트랩.

server_env 를 **수집 전에** 한 번 import 해서 환경변수와 sys.path 를 깔아 둔다.
각 테스트 파일도 자기 첫 줄에서 같은 모듈을 import 하므로(단독 실행 `python tests/test_x.py`
대비) 여기는 pytest 로 돌릴 때의 안전망이자 tests/ 를 sys.path 에 올리는 역할이다.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import server_env  # noqa: E402,F401  (import 자체가 환경 준비다)
