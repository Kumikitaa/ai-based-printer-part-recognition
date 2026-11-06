# Jun의 통합 코드 설명과 시연 순서

## 이번에 한 일

최신 공동 main의 22f8852를 기준으로 작업했다. 키릴의 비동기 DB와 E877 탐지를
유지하면서 인식 기록·피드백·ZIP을 연결했다. 기존 DB 5개 테이블은 유지하고
기록 소유 정보(recognition_contexts), 피드백(prediction_feedback) 테이블만 추가했다.
기존 모델을 연결한 것이며 새 모델을 학습하거나 E731/E786 탐지를 추가하지 않았다.

## 먼저 기억할 흐름

사진 선택 → JavaScript 검사·미리보기 → Python에 원본 전송 → Python 실제 이미지 검사
→ YOLO 실행 → 부품 번호로 DB 조회 → 작업 1개와 탐지 N개 저장 → 화면에 표시.

사진에 부품이 3개 있으면 recognition_logs에는 1행, part_predictions에는 3행이 들어간다.
탐지하지 못한 사진도 작업 1행을 남기고 상태를 no-detection으로 저장한다.

## 키릴에게 코드 보여주는 순서

### 1. main.js: setFile(), callApi()

한국어: 브라우저에서 파일 크기와 형식을 확인하고 미리보기를 만듭니다. 인식 버튼을
누르면 원본 사진과 선택한 프린터를 Python으로 보냅니다.

English: JavaScript checks the file and shows a preview. When the user starts
recognition, it sends the original image and the selected printer to Python.

### 2. detection_api.py: decode_image(), detect()

한국어: Python이 실제 이미지인지 다시 검사하고 기존 E877 탐지 모델을 실행합니다.
이미지 검사는 인식 요청 안에서 하며, 별도의 사전 검증 API는 없습니다.

English: Python validates the actual image and runs the existing E877 detector.
The backend validates the image before inference.

### 3. result_api.py: save_recognition()

한국어: 키릴의 RecognitionLog에는 인식 작업 한 번을, PartPrediction에는 탐지한
부품 각각을 저장합니다. DB 저장 중 오류가 나면 변경을 취소하고 새 이미지도 정리합니다.

English: I use your RecognitionLog for one recognition and PartPrediction for each
detected part. They are saved in one database transaction.

박스 좌표는 DB에서 왼쪽 위·오른쪽 아래의 픽셀 좌표를 쓰고, 화면에는 중심점·너비·높이의
비율 좌표로 변환해서 전달한다. DB 부품 ID, 모델 클래스 번호, 부품 번호는 서로 다른 값이다.

### 4. result_api.py: feedback()

한국어: 사용자의 수정 의견은 각 prediction_id에 연결해 별도로 저장합니다. 화면 정렬
순서가 바뀌어도 같은 예측에 연결되며 원래 모델의 예측은 덮어쓰지 않습니다.

English: Feedback is linked to the prediction ID. It is stored separately, so the
original prediction stays unchanged. This does not automatically retrain the model.

### 5. main.js: openHistory(), show()

한국어: History에서 기록을 누르면 DB에 저장된 이미지와 결과를 다시 가져옵니다.
피드백도 함께 복원합니다. 브라우저 localStorage로 기록을 저장하던 코드는 제거했습니다.

English: History loads saved results from Python. The user can reopen the image,
bounding boxes and feedback after reloading the page.

### 6. result_api.py: export()

한국어: Python이 저장된 결과로 PNG·JSON·CSV를 ZIP으로 만듭니다. JavaScript는 다운로드
주소만 요청합니다. PNG에는 박스가 표시되지만 브라우저에서 선택한 강조 상태까지 같지는 않습니다.

English: Python creates the ZIP from the saved result. It contains an annotated PNG,
JSON and CSV, including the latest saved feedback.

## 시연 방법

1. 프로젝트 루트에서 `python -m uvicorn app:app --app-dir web_app/backend --host 127.0.0.1 --port 8004` 실행.
2. http://127.0.0.1:8004/ 에서 E877 선택.
3. 검증에 사용한 5456.jpg 같은 지원 부품 사진 업로드 후 Start recognition.
4. 부품 번호·신뢰도·박스·호환 프린터 확인.
5. 테스트용으로 피드백을 선택하고 Saved to the database 메시지 확인.
6. 새로고침 → History → Open result로 피드백과 이미지가 남아 있는지 확인.
7. ZIP을 내려받아 results.json, results.csv, annotated.png 확인.
8. 빈 사진은 No detection 상태로 기록되는 것을 확인.

테스트용 피드백은 실제 정답 라벨이 아니다. 시연 후 지우거나 테스트 자료로 구분한다.

## 확인 결과와 한계

- 실제 사진에서 3SJ00-60110을 신뢰도 약 95.2%로 탐지했다.
- DB 저장, 새로고침 후 복원, 피드백 유지, ZIP 생성, 다른 브라우저의 접근 거부를 확인했다.
- 자동 테스트는 다중 부품, 저장 실패 시 취소, 잘못된 파일, 기록 삭제, 앱 재시작 시 유지까지 확인했다.
- 95.2%는 한 예측의 신뢰도이며 모델 전체 정확도가 아니다.
- E877만 인식하며 E731/E786은 카탈로그 조회 가능 여부와 인식 지원을 구분해야 한다.
- 쿠키로 브라우저를 구분한다. 로그인 계정이 아니므로 다른 기기에 기록이 자동 동기화되지 않는다.
- 이전 별도 DB와 localStorage 기록은 자동 이전하지 않았다.
- 외부 공개 주소는 아직 만들지 않았고, 127.0.0.1은 내 컴퓨터에서만 열린다.

## DB를 직접 확인하려면

DB Browser for SQLite에서 `web_app/backend/runtime/PrinterPartCatalogue.db`를 연다.
`database/PrinterPartCatalogue.db`는 원본 카탈로그이므로 새 기록이 없는 것이 정상이다.
runtime 폴더에는 사용자 사진과 기록이 들어가므로 GitHub에 올리지 않는다.

새 코드는 기존 DB 스키마에 테이블만 추가한다. 원본 카탈로그를 나중에 바꿔도 이미 생성된
runtime DB에 자동 덮어쓰지는 않는다. 팀에서 카탈로그 갱신 방식을 정해야 한다.
