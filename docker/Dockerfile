# Python standard library only — nothing to install, so no build stage and no
# pip step. The image is the interpreter plus ~300 KB of source.
FROM python:3.12-slim

WORKDIR /app

# Baked in so the image runs standalone. In the compose setup the host's copy
# is bind-mounted over this path, which is what makes a code update a restart
# (about a second) instead of an image rebuild.
COPY moodboards/ /app/moodboards/

# The code mount is read-only, so don't try to write .pyc files into it.
ENV PYTHONDONTWRITEBYTECODE=1

VOLUME ["/data"]
ENV MOODBOARDS_DATA=/data
EXPOSE 8765

CMD ["python", "-m", "moodboards", "--host", "0.0.0.0", "--port", "8765", "--data", "/data"]
