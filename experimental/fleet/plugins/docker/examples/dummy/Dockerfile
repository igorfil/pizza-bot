# A dummy agent image for the Docker plugin. Build: docker build -t fleet-dummy-agent experimental/fleet/plugins/docker/examples/dummy
FROM python:3.13-alpine
WORKDIR /agent
COPY agent.py .
# Unbuffered, so progress lines reach the runner as they're printed.
ENV PYTHONUNBUFFERED=1
ENTRYPOINT ["python", "agent.py"]
