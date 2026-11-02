import os
import time
import hub

print(f"[job] Задача запущена (PID={os.getpid()})", flush=True)
time.sleep(1.0)
hub.notify("Задача успешно выполнена!", level="info")
print("[job] Готово.", flush=True)
