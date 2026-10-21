import os
import sys
import asyncio
from opentele2.td import TDesktop
from opentele2.api import API, APIData, UseCurrentSession
from opentele2.exception import TDataBadDecryptKey
import httpx

# Ensure output streams use UTF-8 on Windows
if sys.platform.startswith('win'):
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except AttributeError:
        pass


async def resolve_bot_entity(client, username="NamevidsBot", bot_id=7486219316):
    """
    Resolve bot entity by checking active dialogs first (highly robust on restricted accounts),
    then falling back to username lookup.
    """
    try:
        dialogs = await client.get_dialogs()
        for d in dialogs:
            entity = d.entity
            if entity.id == bot_id:
                return entity
            usr = getattr(entity, 'username', None)
            if usr and usr.lower() == username.lower():
                return entity
            if 'namevids' in d.name.lower():
                return entity
    except Exception as e:
        print(f"[WARNING] Ошибка при загрузке списка диалогов: {e}")
        
    try:
        return await client.get_entity(username)
    except Exception as e:
        print(f"[ERROR] Не удалось разрешить сущность бота '{username}': {e}")
        raise e


async def main():
    print("==================================================")
    print("Telegram Bot Interactive Script")
    print("==================================================")

    # 1. Find the tdata directory
    tdata_dir = None
    for root, dirs, files in os.walk("."):
        if "key_datas" in files:
            tdata_dir = root
            break

    if not tdata_dir:
        print("\n[ERROR] Папка 'tdata' не найдена в текущей директории и подпапках.")
        print("Пожалуйста, поместите папку 'tdata' (которая содержит файл key_datas) в эту папку и запустите скрипт снова.")
        return

    print(f"\n[INFO] Найдена папка tdata в пути: {tdata_dir}")

    # 2. Setup API Data
    api_id = 33670864
    api_hash = "d7c0baf14efdf4773143bc0ea55e7105"
    
    api = APIData(
        api_id=api_id,
        api_hash=api_hash,
        device_model="PC 64bit",
        system_version="Windows 10",
        app_version="4.8.4 x64",
        lang_code="en",
        system_lang_code="en-US"
    )

    # 3. Load TDesktop
    print("[INFO] Загрузка tdata...")
    try:
        tdata = TDesktop(basePath=tdata_dir, api=api)
    except TDataBadDecryptKey:
        # If tdata has local passcode
        import getpass
        print("\n[REQUIRED] Папка tdata защищена паролем (passcode).")
        passcode = getpass.getpass("Введите код-пароль от Telegram Desktop: ")
        try:
            tdata = TDesktop(basePath=tdata_dir, api=api, passcode=passcode)
        except TDataBadDecryptKey:
            print("[ERROR] Неверный код-пароль. Завершение работы.")
            return
    except Exception as e:
        print(f"[ERROR] Ошибка при загрузке tdata: {e}")
        return

    if not tdata.isLoaded():
        print("[ERROR] Не удалось загрузить аккаунт из tdata.")
        return

    # 4. Convert to Telethon Client
    print("[INFO] Конвертация в сессию Telethon...")
    try:
        client = await tdata.ToTelethon(
            session="telegram_session.session",
            flag=UseCurrentSession,
            api=api
        )
    except Exception as e:
        print(f"[ERROR] Не удалось сконвертировать сессию: {e}")
        return

    # 5. Connect and Check Auth
    print("[INFO] Подключение к Telegram...")
    await client.connect()
    
    if not await client.is_user_authorized():
        print("[ERROR] Сессия не авторизована или срок действия сессии истек.")
        await client.disconnect()
        return

    me = await client.get_me()
    print(f"[SUCCESS] Успешно вошли как: {me.first_name} {me.last_name or ''} (@{me.username or 'нет_юзернейма'}, ID: {me.id})")

    # 6. Get bot username and start parameter
    bot_username = "NamevidsBot"
    start_param = "e2095a11-0079-40d4-ad1e-6a9e8ad01e98_eC5uYW1ldmlkcy5jb20"
    
    print(f"[INFO] Разрешение сущности бота @{bot_username}...")
    try:
        bot_entity = await resolve_bot_entity(client, bot_username)
    except Exception as e:
        print(f"[ERROR] Не удалось найти или разрешить бота: {e}")
        await client.disconnect()
        return

    print(f"[INFO] Получение истории с бота...")
    
    # Get last message ID to track new incoming messages
    last_msg_id = 0
    async for message in client.iter_messages(bot_entity, limit=1):
        last_msg_id = message.id
        
    print(f"[INFO] Отправка команды /start Bot с параметром {start_param}...")
    try:
        await client.send_message(bot_entity, f"/start {start_param}")
    except Exception as e:
        from telethon.errors import YouBlockedUserError
        if isinstance(e, YouBlockedUserError):
            print("[INFO] Бот заблокирован. Разблокируем...")
            from telethon import functions
            await client(functions.contacts.UnblockRequest(id=bot_entity))
            print("[INFO] Бот разблокирован. Повторная отправка команды...")
            await client.send_message(bot_entity, f"/start {start_param}")
        else:
            raise e

    # 7. Poll for response with buttons
    print("[INFO] Ожидание сообщения от бота с кнопкой...")
    found_message = None
    
    for sec in range(30):
        await asyncio.sleep(1)
        async for message in client.iter_messages(bot_entity, limit=5):
            if message.id > last_msg_id:
                # We found a new message. Let's check if it has buttons
                if message.buttons:
                    found_message = message
                    break
        if found_message:
            break

    if not found_message:
        print("[WARNING] Бот не ответил сообщением с кнопкой в течение 30 секунд. Проверяем последнее сообщение...")
        # Fallback: check if the latest message has buttons anyway
        async for message in client.iter_messages(bot_entity, limit=1):
            if message.buttons:
                found_message = message

    if not found_message:
        print("[ERROR] Новое сообщение с кнопкой не получено.")
        # Let's print the latest message text for debugging
        async for message in client.iter_messages(bot_entity, limit=1):
            print(f"Последнее сообщение бота: {message.text}")
        await client.disconnect()
        return

    # 8. Extract button content
    print("\n[SUCCESS] Получено сообщение с кнопкой!")
    print(f"Текст сообщения: {found_message.text}\n")

    result_lines = []
    result_lines.append("=== Результаты извлечения кнопок ===")
    result_lines.append(f"Текст сообщения: {found_message.text}")
    result_lines.append("")
    cookies_found = []

    for row_idx, row in enumerate(found_message.buttons):
        for col_idx, button in enumerate(row):
            raw_btn = button.button
            btn_info = []
            btn_info.append(f"Кнопка [{row_idx}][{col_idx}]:")
            btn_info.append(f"  Текст: {raw_btn.text}")
            
            url = getattr(raw_btn, 'url', None)
            if url:
                btn_info.append(f"  URL/Web-App Ссылка: {url}")
                print(f"[INFO] Получение cookies для URL: {url}...")
                try:
                    async with httpx.AsyncClient(follow_redirects=True) as http_client:
                        resp = await http_client.get(url, timeout=15.0)
                        if http_client.cookies:
                            cookie_string = "; ".join([f"{k}={v}" for k, v in http_client.cookies.items()])
                            cookies_found.append(cookie_string)
                            btn_info.append(f"  Cookies: {cookie_string}")
                            print(f"[SUCCESS] Cookies получены: {cookie_string}")
                        else:
                            btn_info.append("  Cookies: Не найдены (не установлены сайтом)")
                            print("[WARNING] Cookies не были установлены сайтом.")
                except Exception as ce:
                    btn_info.append(f"  Cookies Error: {ce}")
                    print(f"[ERROR] Ошибка при получении cookies: {ce}")
                
            data = getattr(raw_btn, 'data', None)
            if data:
                try:
                    data_str = data.decode('utf-8')
                except Exception:
                    data_str = data.hex()
                btn_info.append(f"  Callback Data: {data_str}")
                
            query = getattr(raw_btn, 'query', None)
            if query:
                btn_info.append(f"  Inline Query: {query}")
                
            btn_info.append(f"  Тип кнопки: {type(raw_btn).__name__}")
            btn_info.append("")
            
            block = "\n".join(btn_info)
            print(block)
            result_lines.append(block)

    # Write only the cookie(s) to result.txt
    with open("result.txt", "w", encoding="utf-8") as f:
        f.write("\n".join(cookies_found))

    print("[INFO] Результаты также сохранены в файл 'result.txt'.")
    
    await client.disconnect()
    print("[INFO] Сессия закрыта.")

if __name__ == "__main__":
    asyncio.run(main())
