// 테스트 자식 프로세스의 console.* 를 stdout 대신 stderr 로 보낸다 — run-all.mjs 가 --import 로 싣는다.
//
// 왜 필요한가
//   Node 20.16(Electron 30) 러너는 자식 stdout 한 줄기에 v8 직렬화 프레임과 console 출력을 섞어 받는다.
//   runner.js #proccessRawBuffer 는 프레임 하나를 읽은 뒤 남은 바이트가 헤더(FF 0F)로 시작하는지 보지 않고
//   [2..5] 바이트를 길이로 읽는다. 바로 뒤에 붙은 텍스트가 한글이면(UTF-8 바이트 ≥ 0x80) `<< 24` 가 음수가 되어
//   쓰레기를 역직렬화하고 "Unable to deserialize cloned data ..." uncaughtException 으로 파일 하나가 통째로 깨진다.
//   ASCII 는 길이가 수억으로 나와 다음 청크를 기다리므로 무사하다. 청크가 어떻게 합쳐지느냐에 달려 있어 간헐적이다.
//   stderr 는 readline 으로 줄 단위로 읽어서 이 문제가 없다.
// ponytail: Electron 이 이 파서를 고친 Node 버전을 실으면 이 파일과 --import 를 지운다.
import { Console } from 'node:console';

if (process.env.NODE_TEST_CONTEXT === 'child-v8') {
    Object.assign(console, new Console(process.stderr));
}
