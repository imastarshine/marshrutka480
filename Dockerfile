FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
    && groupadd --gid 10001 game \
    && useradd --uid 10001 --gid 10001 --no-create-home game \
    && mkdir -p /app/data \
    && chown game:game /app/data
COPY --chown=game:game backend ./backend
COPY --chown=game:game web ./web
COPY --chown=game:game run.py ./run.py
USER 10001:10001
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=3)" || exit 1
CMD ["python", "run.py", "--host", "0.0.0.0", "--port", "8000"]
