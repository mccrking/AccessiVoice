"""Run the browser-test server with isolated, disposable user data."""
import os
from tempfile import TemporaryDirectory
import uvicorn


if __name__ == '__main__':
    with TemporaryDirectory(prefix='accessivoice-e2e-') as directory:
        os.environ['ACCESSIVOICE_RUNTIME_DIR'] = directory
        uvicorn.run('backend.main:app', host='127.0.0.1', port=8011)
