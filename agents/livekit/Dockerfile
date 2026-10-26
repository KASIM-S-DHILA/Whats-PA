FROM ghcr.io/astral-sh/uv:python3.13-bookworm-slim
ENV PYTHONUNBUFFERED=1 UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev
COPY agent.py voice_tools.py call_archive.py worker_endpoint.py ./
RUN useradd --create-home --uid 10001 agent && chown -R agent:agent /app
ENV PATH="/app/.venv/bin:$PATH"
USER agent
RUN python -m livekit.agents download-files
CMD ["python", "agent.py", "start"]
