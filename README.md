# 날잡자

링크 하나로 다 같이 되는 날을 찾는 약속 잡기 페이지예요.

**주소:** https://naljapja.github.io/

## 쓰는 법
1. **약속 만들기**: 약속 이름, 날짜 범위, 참여자 명단을 넣어요.
2. **링크 보내기**: 만들어진 링크를 단톡방에 올려요.
3. **되는 날 고르기**: 각자 내 이름을 누르고 되는 날을 골라요. 나중에 수정할 수 있어요.
4. **짝짝짝**: 명단에 있는 사람이 다 고르면 모두 되는 날이 바로 떠요.

약속을 만든 브라우저에서는 주최자 메뉴가 열려요. 응답을 일찍 마감하거나, 날짜를 확정하거나, 참여자를 넣고 뺄 수 있어요. 이 기록은 다른 브라우저나 기기와 자동으로 공유되지 않아요.

관리 코드는 약속을 만든 브라우저에 보관돼요. 코드가 없는 예전 약속은 날짜 응답은 계속 가능하지만, 주최자 작업에는 권한 복구가 필요해요. [기존 약속의 주최자 권한 복구 절차](docs/legacy-delete-recovery.md)를 참고하세요.

## 구성
- 페이지: `index.html` 한 장 (GitHub Pages로 배포)
- 데이터: Firebase Cloud Firestore (프로젝트 `yaksok-191a7`, 서울 리전)

## 개발 중 확인하기

사이트는 별도 빌드 없이 `index.html`을 정적 서버에서 열면 돼요.
Node.js 24.12 이상에서 다음 명령으로 화면·저장·날짜 회귀 테스트를 확인할 수 있어요. 이 검증은 패키지 설치 없이 실행돼요.

```sh
node --test --test-isolation=none tests/host-state.test.cjs tests/date-state.test.cjs tests/legacy-recovery.test.cjs tests/lightweight-ux.test.cjs
```

테스트는 실제 페이지 코드를 분리된 DOM·시계·저장소에서 실행해요.
Firebase는 가짜 구현을 사용하므로 실제 약속을 읽거나 수정하지 않아요.
서버 규칙은 `firestore.rules`에 있어요. 주최자 변경은 비공개 관리 문서와 약속을 같은 트랜잭션에서 수정해 권한을 확인해요. 일반 참여자의 날짜 응답은 로그인 없이 저장돼요.

규칙 검증에는 Java 21 이상과 개발용 패키지가 필요해요. 사이트 이용자에게 내려가는 파일이나 라이브러리는 추가하지 않아요.

```sh
pnpm install --frozen-lockfile
pnpm test:rules
```

규칙 테스트는 `demo-naljapja-tests` 프로젝트와 `127.0.0.1:8180`의 로컬 Firestore 에뮬레이터만 사용해요. 운영 데이터에는 연결하지 않아요.

## 배포

GitHub Pages는 `main`의 정적 파일을 배포해요. Firestore 규칙은 별도 배포이므로 `index.html`과 `firestore.rules` 변경을 함께 검토하고 두 곳의 반영을 확인해야 해요. 기존 탭은 새로고침해야 새 주최자 권한 확인 방식이 적용돼요.
