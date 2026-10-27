# varryup
상품업로드 자동화

## 저장소에서 받은 폴더로 실행

1. [Node.js LTS](https://nodejs.org)를 설치합니다.
2. `실행.bat`을 더블클릭합니다. ZIP으로 받았다면 먼저 ZIP을 오른쪽 클릭해 '압축 풀기'를 하고, 풀린 폴더의 `실행.bat`을 누릅니다.
   처음 한 번은 `npm ci`로 패키지를 설치합니다(electron 포함, 약 190MB를 내려받아 약 500MB). 인터넷이 필요하고 몇 분 걸립니다.
3. 다음부터는 `실행.bat`만 누르면 바로 켜집니다.

- `node_modules`는 저장소에 올리지 않습니다. 오류가 나면 창에 이유가 남습니다.
- 같은 PC에서 VERY UP이 이미 켜져 있으면 새 창 대신 켜진 창이 앞으로 옵니다(한 번에 하나만 실행).
- 직원 PC는 이 방법 대신 설치 파일을 씁니다 — `배포_가이드.md`.

<img width="1182" height="838" alt="image" src="https://github.com/user-attachments/assets/188d73ea-d5fa-4c05-84b9-2a901b8aaecc" />
