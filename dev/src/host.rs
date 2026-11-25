use crate::lnbits::extension::host as wit;

pub fn now() -> u64 {
    wit::now().timestamp
}

pub fn log(message: &str, level: &str) {
    wit::log(&wit::LogRequest {
        level: level.into(),
        message: message.into(),
    });
}

pub fn extension(id: &str, method: &str, path: &str, body: Option<String>) -> (u16, String) {
    let r = wit::extension_api_request(&wit::ExtensionApiRequestOptions {
        extension_id: id.into(),
        method: method.into(),
        path: path.into(),
        body,
    });
    (r.status_code, r.body)
}
