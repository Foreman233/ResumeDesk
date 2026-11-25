use std::{fs, io::Write, path::Path};

use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, Zeroizing};

use crate::{
    model::{Result, message},
    store::reject_link,
};

#[derive(Serialize, Deserialize)]
pub struct Credential {
    pub endpoint: String,
    pub model: String,
    pub key: String,
    pub verified: bool,
}
impl Drop for Credential {
    fn drop(&mut self) {
        self.key.zeroize();
    }
}

const NAME: &str = "ai-key.dpapi";
const SEARCH_NAME: &str = "web-search-key.dpapi";

pub fn load(root: &Path) -> Result<Option<Credential>> {
    load_slot(root, NAME)
}

pub fn load_search(root: &Path) -> Result<Option<Credential>> {
    load_slot(root, SEARCH_NAME)
}

fn load_slot(root: &Path, name: &str) -> Result<Option<Credential>> {
    let path = root.join(name);
    reject_link(&path)?;
    let info = match fs::metadata(&path) {
        Ok(info) => info,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    if !info.is_file() || info.len() > 64 * 1024 {
        return Err(message("Windows 凭据文件异常，请重新保存 API Key。"));
    }
    let protected = fs::read(&path)?;
    let plain = Zeroizing::new(platform::transform(&protected, false)?);
    Ok(Some(serde_json::from_slice(&plain).map_err(|_| {
        message("无法读取 Windows 凭据，请重新保存 API Key。")
    })?))
}

pub fn save(root: &Path, credential: Option<&Credential>) -> Result<()> {
    save_slot(root, NAME, credential)
}

pub fn save_search(root: &Path, credential: Option<&Credential>) -> Result<()> {
    save_slot(root, SEARCH_NAME, credential)
}

fn save_slot(root: &Path, name: &str, credential: Option<&Credential>) -> Result<()> {
    let path = root.join(name);
    reject_link(&path)?;
    if let Some(credential) = credential {
        let plain = Zeroizing::new(serde_json::to_vec(credential)?);
        let protected = platform::transform(&plain, true)?;
        let mut temp = tempfile::NamedTempFile::new_in(root)?;
        temp.write_all(&protected)?;
        temp.as_file().sync_all()?;
        temp.persist(path).map_err(|e| e.error)?;
    } else if path.exists() {
        fs::remove_file(path)?;
    }
    Ok(())
}

#[cfg(windows)]
mod platform {
    use std::{
        ptr::{null, null_mut},
        slice,
    };
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
        },
    };
    use zeroize::Zeroize;

    use crate::model::{Result, message};

    pub(super) fn transform(input: &[u8], encrypt: bool) -> Result<Vec<u8>> {
        let input = CRYPT_INTEGER_BLOB {
            cbData: input.len() as u32,
            pbData: input.as_ptr().cast_mut(),
        };
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: null_mut(),
        };
        // DPAPI uses the current Windows account by default. LocalFree owns the output.
        unsafe {
            let status = if encrypt {
                CryptProtectData(
                    &input,
                    null(),
                    null(),
                    null(),
                    null(),
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut output,
                )
            } else {
                CryptUnprotectData(
                    &input,
                    null_mut(),
                    null(),
                    null(),
                    null(),
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut output,
                )
            };
            if status == 0 || output.pbData.is_null() {
                return Err(message(
                    "Windows 无法保护或解锁 API Key，请在当前账户重新保存。",
                ));
            }
            let source = slice::from_raw_parts_mut(output.pbData, output.cbData as usize);
            let data = source.to_vec();
            source.zeroize();
            LocalFree(output.pbData.cast());
            Ok(data)
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use crate::model::{Result, message};
    pub(super) fn transform(_: &[u8], _: bool) -> Result<Vec<u8>> {
        Err(message("此版本使用 Windows 当前账户保护 API Key。"))
    }
}
