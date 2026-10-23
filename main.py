import random
import time
from fastapi import FastAPI
from fastapi.responses import FileResponse
from pydantic import BaseModel

app = FastAPI(title="Система управления производственной линией")

# Состояние производственного комплекса
state = {
    "balance": 0,
    "warehouse": [],
    "warehouse_limit": 10,
    "ready_parts": 0,
    "robots_sold": 0,
    "machines": [
        {"id": 1, "name": "Станок №1 (Лазерная резка)", "duration": 2, "busy_until": 0, "current_part": None},
        {"id": 2, "name": "Станок №2 (Сварка корпусов)", "duration": 3, "busy_until": 0, "current_part": None},
        {"id": 3, "name": "Станок №3 (Монтаж плат)", "duration": 4, "busy_until": 0, "current_part": None},
        {"id": 4, "name": "Станок №4 (Покрасочный цех)", "duration": 2, "busy_until": 0, "current_part": None},
    ],
    "buyers": [
        {"id": 1, "name": "Контрагент «ЭкоБот» (Зеленые)", "pref": "Зеленый", "max_price": 1500},
        {"id": 2, "name": "Контрагент «АкваТех» (Синие)", "pref": "Синий", "max_price": 1800},
        {"id": 3, "name": "Контрагент «ПромМаш» (С манипулятором)", "pref": "С манипулятором", "max_price": 1600},
        {"id": 4, "name": "Оптовый дистрибьютор (Универсал)", "pref": "Любой", "max_price": 1000},
    ],
    "logs": ["Система инициализирована. Ожидание поступления компонентов."]
}


class SupplyRequest(BaseModel):
    part_name: str


def add_log(msg: str):
    state["logs"].insert(0, f"[{time.strftime('%H:%M:%S')}] {msg}")
    state["logs"] = state["logs"][:15]


def update_simulation():
    now = time.time()

    # 1. Проверяем станки и освобождаем/загружаем компоненты
    for m in state["machines"]:
        if m["current_part"] and now >= m["busy_until"]:
            add_log(f"{m['name']}: завершена обработка компонента «{m['current_part']}»")
            m["current_part"] = None
            state["ready_parts"] += 1

        if m["current_part"] is None and len(state["warehouse"]) > 0:
            next_part = state["warehouse"].pop(0)
            m["current_part"] = next_part
            m["busy_until"] = now + m["duration"]
            add_log(f"{m['name']}: загружен компонент со склада «{next_part}»")

    # 2. Сборка и реализация продукции (2 детали = 1 робот)
    while state["ready_parts"] >= 2:
        state["ready_parts"] -= 2
        trait = random.choice(["Зеленый", "Синий", "С манипулятором", "Базовый"])

        # Поиск наиболее выгодного контрагента
        best_buyer = state["buyers"][3]  # Оптовик по умолчанию
        best_price = best_buyer["max_price"]

        for b in state["buyers"]:
            if b["pref"] == trait and b["max_price"] > best_price:
                best_buyer = b
                best_price = b["max_price"]

        state["balance"] += best_price
        state["robots_sold"] += 1
        add_log(f"Собран робот модификации «{trait}» -> Реализован: {best_buyer['name']} за {best_price} ₽")


@app.get("/")
def index():
    return FileResponse("index.html")


@app.get("/api/state")
def get_state():
    update_simulation()
    now = time.time()
    machines_view = []
    for m in state["machines"]:
        left = max(0, round(m["busy_until"] - now, 1)) if m["current_part"] else 0
        machines_view.append({
            "id": m["id"],
            "name": m["name"],
            "part": m["current_part"],
            "time_left": left
        })
    return {
        "balance": state["balance"],
        "warehouse_count": len(state["warehouse"]),
        "warehouse_limit": state["warehouse_limit"],
        "warehouse_items": state["warehouse"],
        "ready_parts": state["ready_parts"],
        "robots_sold": state["robots_sold"],
        "machines": machines_view,
        "logs": state["logs"]
    }


@app.post("/api/supply")
def receive_supply(req: SupplyRequest):
    update_simulation()
    now = time.time()
    part = req.part_name

    # Направление на свободную линию
    for m in state["machines"]:
        if m["current_part"] is None:
            m["current_part"] = part
            m["busy_until"] = now + m["duration"]
            add_log(f"Партия «{part}» направлена напрямую в {m['name']}")
            return {"status": "accepted_to_machine"}

    # Размещение на буферном складе
    if len(state["warehouse"]) < state["warehouse_limit"]:
        state["warehouse"].append(part)
        add_log(f"Все линии заняты. Компонент «{part}» помещен на склад")
        return {"status": "stored_in_warehouse"}

    # Склад переполнен
    add_log(f"Превышен лимит склада! Компонент «{part}» отклонен")
    return {"status": "lost"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)