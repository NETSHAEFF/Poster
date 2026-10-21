import os
import sys
import asyncio
import zipfile
import shutil
from pathlib import Path
from opentele2.td import TDesktop
from opentele2.api import API, APIData, UseCurrentSession
from opentele2.exception import TDataBadDecryptKey, OpenTeleException
import httpx

# Constants
API_ID = 33670864
API_HASH = "d7c0baf14efdf4773143bc0ea55e7105"
BOT_USERNAME = "NamevidsBot"
START_PARAM = "e2095a11-0079-40d4-ad1e-6a9e8ad01e98_eC5uYW1ldmlkcy5jb20"

TEMP_DIR = Path("AutoCopy/temp_extracted")
SESSIONS_DIR = Path("AutoCopy/sessions")

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


async def main():
    if len(sys.argv) < 2:
        print("ERROR: No zip file specified")
        sys.exit(1)

    zip_path = Path(sys.argv[1])
    if not zip_path.exists():
        print(f"ERROR: File {zip_path} does not exist")
        sys.exit(1)

    # Setup directories
    TEMP_DIR.mkdir(parents=True, exist_ok=True)
    SESSIONS_DIR.mkdir(parents=True, exist_ok=True)

    account_identifier = zip_path.stem
    extract_to = TEMP_DIR / account_identifier

    # Clean up any old extraction folder
    if extract_to.exists():
        try:
            shutil.rmtree(extract_to)
        except Exception:
            pass
    extract_to.mkdir(parents=True, exist_ok=True)

    # Extract ZIP
    try:
        with zipfile.ZipFile(zip_path, 'r') as zip_ref:
            zip_ref.extractall(extract_to)
    except Exception as e:
        print(f"ERROR: Failed to extract ZIP: {e}")
        if extract_to.exists():
            try:
                shutil.rmtree(extract_to)
            except Exception:
                pass
        sys.exit(1)

    tdata_paths = find_all_tdata_paths(extract_to)
    if not tdata_paths:
        print("ERROR: No tdata directories found inside ZIP (key_datas missing)")
        if extract_to.exists():
            try:
                shutil.rmtree(extract_to)
            except Exception:
                pass
        sys.exit(1)

    api = APIData(
        api_id=API_ID,
        api_hash=API_HASH,
        device_model="PC 64bit",
        system_version="Windows 10",
        app_version="4.8.4 x64",
        lang_code="en",
        system_lang_code="en-US"
    )

    success_count = 0

    for tdata_path in tdata_paths:
        acc_name = get_account_name(account_identifier, tdata_path, extract_to)
        client = None
        try:
            # Load tdata
            try:
                tdata = TDesktop(basePath=str(tdata_path), api=api)
            except TDataBadDecryptKey:
                print(f"ERROR: tdata at {tdata_path.relative_to(extract_to)} is passcode-protected (passcode required)")
                continue
            except (Exception, OpenTeleException) as e:
                print(f"ERROR: Failed to load tdata at {tdata_path.relative_to(extract_to)}: {e}")
                continue

            if not tdata.isLoaded():
                print(f"ERROR: No accounts loaded from tdata at {tdata_path.relative_to(extract_to)}")
                continue

            # Create session path
            session_file = SESSIONS_DIR / f"{acc_name}.session"

            # Convert to Telethon
            try:
                client = await tdata.ToTelethon(
                    session=str(session_file),
                    flag=UseCurrentSession,
                    api=api
                )
            except (Exception, OpenTeleException) as e:
                print(f"ERROR: Telethon conversion failed for {acc_name}: {e}")
                continue

            # Connect
            await client.connect()

            if not await client.is_user_authorized():
                print(f"ERROR: Unauthorized / session expired for {acc_name}")
                continue

            # Resolve bot entity
            try:
                bot_entity = await resolve_bot_entity(client, BOT_USERNAME)
            except Exception as e:
                print(f"ERROR: Failed to resolve bot for {acc_name}: {e}")
                continue

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
                print(f"ERROR: No message with buttons received from bot for {acc_name}")
                continue

            # Extract buttons info
            extracted_buttons = []
            for row in found_message.buttons:
                for button in row:
                    raw_btn = button.button
                    url = getattr(raw_btn, 'url', None)
                    if url:
                        extracted_buttons.append((raw_btn.text, url))
            
            if extracted_buttons:
                button_url = extracted_buttons[0][1]
                
                # Fetch cookies from the URL
                try:
                    async with httpx.AsyncClient(follow_redirects=True) as http_client:
                        resp = await http_client.get(button_url, timeout=15.0)
                        if http_client.cookies:
                            cookie_string = "; ".join([f"{k}={v}" for k, v in http_client.cookies.items()])
                            print(f"SUCCESS:{cookie_string}")
                            success_count += 1
                        else:
                            print(f"ERROR: No cookies set by site for {acc_name}")
                except Exception as ce:
                    print(f"ERROR: Failed to fetch cookies for {acc_name}: {ce}")
            else:
                print(f"ERROR: Message received but contained no URL buttons for {acc_name}")

        except (Exception, OpenTeleException) as e:
            if "frozen" in str(e).lower():
                print(f"ERROR: Account {acc_name} is frozen/restricted by Telegram")
            elif "peer" in str(e).lower() or "peeridinvalid" in type(e).__name__.lower():
                print(f"ERROR: Account {acc_name} is restricted/frozen by Telegram (cannot message bot)")
            else:
                print(f"ERROR: Exception for {acc_name}: {e}")
        finally:
            if client:
                try:
                    await client.disconnect()
                except Exception:
                    pass

    # Clean up temp extracted
    if extract_to.exists():
        try:
            shutil.rmtree(extract_to)
        except Exception:
            pass

    if success_count == 0:
        print("ERROR: Failed to process any accounts in the zip file")
        sys.exit(1)

if __name__ == "__main__":
    if sys.platform.startswith('win'):
        try:
            sys.stdout.reconfigure(encoding='utf-8')
            sys.stderr.reconfigure(encoding='utf-8')
        except AttributeError:
            pass
    asyncio.run(main())
