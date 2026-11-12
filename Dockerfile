FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml README.md LICENSE LICENSE-Inter.txt ./
COPY src ./src
RUN pip install --no-cache-dir . \
 && useradd --create-home --uid 10001 viewer \
 && mkdir -p /data /annotations /work && chown viewer /annotations && chmod 1777 /work
USER viewer
WORKDIR /work
ENV S3CACHE_BIND=0.0.0.0 S3CACHE_PORT=8797 HOME=/tmp
EXPOSE 8797
ENTRYPOINT ["ink-viewer"]
CMD ["--origen", "/data", "--anotaciones", "/annotations"]
