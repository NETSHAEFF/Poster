import os
import sys
import asyncio
import zipfile
import shutil
import csv
from pathlib import Path
from opentele2.td import TDesktop
from opentele2.api import API, APIData, UseCurrentSession
from opentele2.exception import TDataBadDecryptKey, OpenTeleException
import httpx

# Ensure output streams use UTF-8 on Windows
if sys.platform.startswith('win'):
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except AttributeError:
        pass

# Constants
API_ID = 33670864
API_HASH = "d7c0baf14efdf4773143bc0ea55e7105"
BOT_USERNAME = "NamevidsBot"
START_PARAM = "e2095a11-0079-40d4-ad1e-6a9e8ad01e98_eC5uYW1ldmlkcy5jb20"

ACCOUNTS_DIR = Path("accounts")
TEMP_DIR = Path("temp_extracted")
SESSIONS_DIR = Path("sessions")
RESULTS_CSV = Path("summary_results.csv")
RESULTS_TXT = Path("summary_results.txt")

def setup_directories():
    ACCOUNTS_DIR.mkdir(exist_ok=True)
    TEMP_DIR.mkdir(exist_ok=True)
    SESSIONS_DIR.mkdir(exist_ok=True)

def clean_temp_dir():
    if TEMP_DIR.exists():
        shutil.rmtree(TEMP_DIR)
    TEMP_DIR.mkdir(exist_ok=True)

def find_all_tdata_paths(search_path: Path) -> list:
    """Recursively search for all directories containing 'key_datas' file."""
    tdata_paths = []
    for root, dirs, files in os.walk(search_path):
        if "key_datas" in files:
            tdata_paths.append(Path(root))
    return tdata_paths

def get_account_name(zip_stem: str, tdata_path: Path, extract_to: Path) -> str:
    try:
        rel_path = tdata_path.relative_to(extract_to)
        parts = rel_path.parts
        clean_parts = [p for p in parts if p.lower() != 'tdata']
        if clean_parts:
            subname = "_".join(clean_parts)
            return f"{zip_stem}_{subname}"
        else:
            return zip_stem
    except Exception:
        return zip_stem

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


async def process_tdata(tdata_path: Path, account_identifier: str) -> dict:
    """Process a single tdata folder: connect, send start, extract buttons."""
    result = {
        "account": account_identifier,
        "status": "Failed",
        "details": "",
        "button_text": "",
        "button_url": "",
        "cookie": ""
    }

    # API configuration matching desktop Telegram
    api = APIData(
        api_id=API_ID,
        api_hash=API_HASH,
        device_model="PC 64bit",
        system_version="Windows 10",
        app_version="4.8.4 x64",
        lang_code="en",
        system_lang_code="en-US"
    )

    client = None
    try:
        # Load tdata
        try:
            tdata = TDesktop(basePath=str(tdata_path), api=api)
        except TDataBadDecryptKey:
            result["details"] = "tdata password-protected (passcode required)"
            return result
        except (Exception, OpenTeleException) as e:
            result["details"] = f"Failed to load tdata: {e}"
            return result

        if not tdata.isLoaded():
            result["details"] = "No accounts loaded from tdata"
            return result

        # Create session path
        session_file = SESSIONS_DIR / f"{account_identifier}.session"

        # Convert to Telethon
        try:
            client = await tdata.ToTelethon(
                session=str(session_file),
                flag=UseCurrentSession,
                api=api
            )
        except (Exception, OpenTeleException) as e:
            result["details"] = f"Telethon conversion failed: {e}"
            return result

        # Connect
        await client.connect()

        if not await client.is_user_authorized():
            result["details"] = "Unauthorized / session expired"
            return result

        me = await client.get_me()
        user_info = f"{me.first_name or ''} {me.last_name or ''} (@{me.username or 'none'}, ID: {me.id})"
        result["account"] = f"{account_identifier} ({user_info})"

        # Resolve bot entity
        try:
            bot_entity = await resolve_bot_entity(client, BOT_USERNAME)
        except Exception as e:
            result["details"] = f"Failed to resolve bot: {e}"
            return result

        # Get last message to track new ones
        last_msg_id = 0
        async for message in client.iter_messages(bot_entity, limit=1):
            last_msg_id = message.id

        # Send start command
        try:
            await client.send_message(bot_entity, f"/start {START_PARAM}")
        except Exception as e:
            from telethon.errors import YouBlockedUserError
            if isinstance(e, YouBlockedUserError):
                from telethon import functions
                await client(functions.contacts.UnblockRequest(id=bot_entity))
                await client.send_message(bot_entity, f"/start {START_PARAM}")
            else:
                raise e

        # Poll for reply with buttons
        found_message = None
        for _ in range(15):
            await asyncio.sleep(1.5)
            async for message in client.iter_messages(bot_entity, limit=5):
                if message.id > last_msg_id and message.buttons:
                    found_message = message
                    break
            if found_message:
                break

        if not found_message:
            # Fallback: check latest message
            async for message in client.iter_messages(bot_entity, limit=1):
                if message.buttons:
                    found_message = message

        if not found_message:
            result["details"] = "No message with buttons received from bot"
            return result

        # Extract buttons info
        extracted_buttons = []
        for row in found_message.buttons:
            for button in row:
                raw_btn = button.button
                url = getattr(raw_btn, 'url', None)
                if url:
                    extracted_buttons.append((raw_btn.text, url))
        
        if extracted_buttons:
            # Save the first URL found
            result["button_text"] = extracted_buttons[0][0]
            result["button_url"] = extracted_buttons[0][1]
            
            # Fetch cookies from the URL
            try:
                async with httpx.AsyncClient(follow_redirects=True) as http_client:
                    resp = await http_client.get(result["button_url"], timeout=15.0)
                    if http_client.cookies:
                        cookie_string = "; ".join([f"{k}={v}" for k, v in http_client.cookies.items()])
                        result["cookie"] = cookie_string
                        result["status"] = "Success"
                        result["details"] = f"Found {len(extracted_buttons)} URL button(s) and retrieved cookies"
                    else:
                        result["cookie"] = ""
                        result["status"] = "Success"
                        result["details"] = f"Found {len(extracted_buttons)} URL button(s) but no cookies set"
            except Exception as ce:
                result["cookie"] = ""
                result["status"] = "Success (Cookie Error)"
                result["details"] = f"Found URL button but failed to get cookies: {ce}"
        else:
            result["details"] = "Message received but contained no URL buttons"

    except (Exception, OpenTeleException) as e:
        if "frozen" in str(e).lower():
            result["details"] = "Account is frozen/restricted by Telegram"
        elif "peer" in str(e).lower() or "peeridinvalid" in type(e).__name__.lower():
            result["details"] = "Account is restricted/frozen by Telegram (cannot message bot)"
        else:
            result["details"] = f"Error during processing: {e}"
    finally:
        if client:
            await client.disconnect()

    return result

async def main():
    print("==================================================")
    print("Mass Telegram TData Processor & Bot URL Extractor")
    print("==================================================")

    setup_directories()
    clean_temp_dir()

    # Find archives and folders in the accounts directory
    zip_files = list(ACCOUNTS_DIR.glob("*.zip"))
    sub_dirs = [d for d in ACCOUNTS_DIR.iterdir() if d.is_dir()]

    total_jobs = len(zip_files) + len(sub_dirs)
    if total_jobs == 0:
        print(f"\n[INFO] Папка '{ACCOUNTS_DIR}' пуста.")
        print(f"Пожалуйста, поместите туда ZIP-архивы с tdata или папки с tdata и запустите скрипт.")
        return

    print(f"\n[INFO] Найдено объектов для обработки: {total_jobs} ({len(zip_files)} ZIP-архивов, {len(sub_dirs)} папок)")
    print("[INFO] Очередь обработки:")
    for idx, folder in enumerate(sub_dirs, 1):
        print(f"  {idx}. [Папка] {folder.name}")
    for idx, zip_file in enumerate(zip_files, len(sub_dirs) + 1):
        print(f"  {idx}. [Архив] {zip_file.name}")

    results = []

    # Process directories
    for folder in sub_dirs:
        print(f"\n--------------------------------------------------")
        print(f"[PROCESS] Обработка папки: {folder.name}")
        tdata_paths = find_all_tdata_paths(folder)
        if not tdata_paths:
            print(f"[WARNING] Файл key_datas не найден в папке {folder.name}. Пропускаем.")
            results.append({
                "account": folder.name,
                "status": "Skipped",
                "details": "No tdata directory found (key_datas missing)",
                "button_text": "",
                "button_url": "",
                "cookie": ""
            })
            continue

        print(f"[INFO] Найдено {len(tdata_paths)} аккаунтов в папке {folder.name}")
        for tdata_path in tdata_paths:
            acc_name = get_account_name(folder.name, tdata_path, folder)
            print(f"\n  [SUB-PROCESS] Обработка аккаунта: {acc_name}")
            res = await process_tdata(tdata_path, acc_name)
            results.append(res)
            print(f"  [RESULT] Статус: {res['status']}. Детали: {res['details']}")
            if res["button_url"]:
                print(f"  [URL] {res['button_url']}")
            if res.get("cookie"):
                print(f"  [COOKIE] {res['cookie']}")

    # Process ZIP files
    for zip_path in zip_files:
        print(f"\n--------------------------------------------------")
        print(f"[PROCESS] Распаковка и обработка архива: {zip_path.name}")
        
        extract_to = TEMP_DIR / zip_path.stem
        extract_to.mkdir(exist_ok=True)

        try:
            with zipfile.ZipFile(zip_path, 'r') as zip_ref:
                zip_ref.extractall(extract_to)
        except Exception as e:
            print(f"[ERROR] Не удалось распаковать {zip_path.name}: {e}")
            results.append({
                "account": zip_path.name,
                "status": "Failed",
                "details": f"Failed to extract ZIP: {e}",
                "button_text": "",
                "button_url": "",
                "cookie": ""
            })
            continue

        tdata_paths = find_all_tdata_paths(extract_to)
        if not tdata_paths:
            print(f"[WARNING] Файл key_datas не найден внутри архива {zip_path.name}. Пропускаем.")
            results.append({
                "account": zip_path.name,
                "status": "Skipped",
                "details": "No tdata directory found inside ZIP",
                "button_text": "",
                "button_url": "",
                "cookie": ""
            })
            continue

        print(f"[INFO] Найдено {len(tdata_paths)} аккаунтов в архиве {zip_path.name}")
        for tdata_path in tdata_paths:
            acc_name = get_account_name(zip_path.stem, tdata_path, extract_to)
            print(f"\n  [SUB-PROCESS] Обработка аккаунта: {acc_name}")
            res = await process_tdata(tdata_path, acc_name)
            results.append(res)
            print(f"  [RESULT] Статус: {res['status']}. Детали: {res['details']}")
            if res["button_url"]:
                print(f"  [URL] {res['button_url']}")
            if res.get("cookie"):
                print(f"  [COOKIE] {res['cookie']}")

    # Clean up extracted temp directory
    clean_temp_dir()

    # Save summary results
    print(f"\n==================================================")
    print(f"Обработка завершена. Запись результатов...")
    
    # 1. Save CSV (only cookies)
    with open(RESULTS_CSV, mode="w", newline="", encoding="utf-8") as csv_file:
        fieldnames = ["cookie"]
        writer = csv.DictWriter(csv_file, fieldnames=fieldnames)
        writer.writeheader()
        for res in results:
            if res.get("cookie"):
                writer.writerow({"cookie": res["cookie"]})

    # 2. Save TXT (only cookies, one per line)
    with open(RESULTS_TXT, mode="w", encoding="utf-8") as txt_file:
        for res in results:
            if res.get("cookie"):
                txt_file.write(f"{res['cookie']}\n")

    print(f"[SUCCESS] CSV результаты сохранены в: {RESULTS_CSV}")
    print(f"[SUCCESS] Текстовые результаты сохранены в: {RESULTS_TXT}")
    print("==================================================")

if __name__ == "__main__":
    asyncio.run(main())
