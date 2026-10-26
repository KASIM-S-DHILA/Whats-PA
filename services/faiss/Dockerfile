FROM python:3.13-slim
WORKDIR /app
COPY requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt && useradd --uid 1000 --create-home app
ENV HF_HOME=/app/hf
RUN python -c "from mistral_common.tokens.tokenizers.mistral import MistralTokenizer; MistralTokenizer.from_hf_hub('mistralai/Mistral-Small-3.1-24B-Instruct-2503', revision='68faf511d618ef198fef186659617cfd2eb8e33a')" && chmod -R a+rX /app/hf
COPY faiss_service.py worker_endpoint.py ./
COPY pdf_extract.py ./pdf_extract.py
COPY pdf_batch.py pdf_tools.py ./
COPY pdf_fast.py pdf_fast_extract.py ./
USER app
ENV PORT=7860 PYTHONUNBUFFERED=1
EXPOSE 7860
CMD ["python", "faiss_service.py"]
