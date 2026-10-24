FROM ultralytics/ultralytics:latest

WORKDIR /workspace

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
RUN apt-get update && apt-get install -y sqlite3

COPY app/ /workspace/app/
COPY models/ /workspace/models/

RUN mkdir -p app/data/
RUN chmod -R 777 app/data/

WORKDIR /workspace/app

# DB 시딩 후 서버 자동 시작
CMD ["sh", "-c", "python seed_db.py && uvicorn main:app --host 0.0.0.0 --port 8000"]
