# Python standard library only — nothing to install, so no build stage and no
# pip step. The image is the interpreter plus ~300 KB of source.
FROM python:3.12-slim

WORKDIR /app
COPY moodboards/ /app/moodboards/

# Boards and images live on a mounted volume, never in the image.
VOLUME ["/data"]
ENV MOODBOARDS_DATA=/data
EXPOSE 8765

# 0.0.0.0 so the container is reachable from the host network. There is no
# authentication — see the README before exposing this beyond a trusted LAN.
CMD ["python", "-m", "moodboards", "--host", "0.0.0.0", "--port", "8765", "--data", "/data"]
