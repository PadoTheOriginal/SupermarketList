FROM python:3.13-slim
# Só o interpretador e as dependências: o código e o banco vêm montados de ./app (compose),
# então editar o app não pede rebuild, só restart.
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt
WORKDIR /srv
ENV PYTHONUNBUFFERED=1
CMD ["python", "app/main.py"]
