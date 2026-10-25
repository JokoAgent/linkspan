use std::{str::FromStr, sync::Arc};
use iroh::{Endpoint, RelayMode, RelayConfig, RelayMap, RelayUrl, SecretKey};
use iroh::endpoint::{presets, Connection, SendStream, RecvStream};
use iroh_tickets::{Ticket as _, endpoint::EndpointTicket};
use tokio::sync::Mutex;
use wasm_bindgen::prelude::*;
use serde::Deserialize;

const ALPN: &[u8] = b"linkspan/iroh-noise/1";
fn error(code: &str) -> JsValue { js_sys::Error::new(code).into() }
fn transport<E>(_: E) -> JsValue { error("transport_error") }
fn stage(name:&str)->JsValue{let value=js_sys::Error::new("transport_error");let _=js_sys::Reflect::set(&value,&JsValue::from_str("linkspanStage"),&JsValue::from_str(name));value.into()}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct RelayOptions { relay_urls: Option<Vec<String>>, relay_token: Option<String>, services_api_secret: Option<String> }

#[wasm_bindgen(js_name = createIrohIdentity)]
pub fn create_iroh_identity() -> String {
    let key = SecretKey::generate();
    serde_json::json!({"privateKey":key.to_bytes().iter().map(|byte|format!("{byte:02x}")).collect::<String>(),"publicKey":key.public().to_string()}).to_string()
}
#[wasm_bindgen(js_name = publicKeyFromPrivate)]
pub fn public_key_from_private(bytes:Vec<u8>)->Result<String,JsValue>{
    let bytes:[u8;32]=bytes.try_into().map_err(|_|error("invalid_argument"))?;Ok(SecretKey::from_bytes(&bytes).public().to_string())
}

#[wasm_bindgen(js_name = issueIrohRelayLease)]
pub fn issue_iroh_relay_lease(api_secret: &str, endpoint_id: &str, ttl_seconds: u32) -> Result<String,JsValue> {
    if !(60..=86400).contains(&ttl_seconds) { return Err(error("invalid_argument")); }
    let api = iroh_services::ApiSecret::from_str(api_secret).map_err(|_|error("invalid_argument"))?;
    let audience = iroh::EndpointId::from_str(endpoint_id).map_err(|_|error("invalid_argument"))?;
    let token = iroh_services::caps::create_api_token_from_secret_key(api.secret,audience,std::time::Duration::from_secs(ttl_seconds as u64),iroh_services::caps::Caps::new([iroh_services::caps::Cap::Relay(iroh_services::caps::RelayCap::Use)])).map_err(transport)?;
    let encoded = data_encoding::BASE32_NOPAD.encode(&token.encode()).to_ascii_lowercase();
    let expires_at=match token.expires(){rcan::Expires::At(seconds)=>seconds*1000,rcan::Expires::Never=>return Err(error("invalid_argument"))};
    Ok(serde_json::json!({"relayToken":encoded,"endpointId":audience.to_string(),"expiresAt":expires_at,"scope":"relay:use"}).to_string())
}

#[wasm_bindgen]
pub struct IrohEndpoint { endpoint: Endpoint }

#[wasm_bindgen]
impl IrohEndpoint {
    #[wasm_bindgen(js_name = bind)]
    pub async fn bind(secret: Vec<u8>, config: &str) -> Result<IrohEndpoint, JsValue> {
        let relay: RelayOptions = serde_json::from_str(config).map_err(|_| error("invalid_argument"))?;
        let mut builder = Endpoint::builder(presets::N0).alpns(vec![ALPN.to_vec()]);
        let explicit_key = if secret.is_empty() { None } else { let bytes:[u8;32] = secret.as_slice().try_into().map_err(|_|error("invalid_argument"))?; Some(SecretKey::from_bytes(&bytes)) };
        if let Some(key) = &explicit_key { builder = builder.secret_key(key.clone()); }
        if let Some(api) = relay.services_api_secret {
            let _=api;return Err(error("invalid_argument"));
        }
        if relay.relay_token.is_some() && relay.relay_urls.is_none() { return Err(error("invalid_argument")); }
        if let Some(urls) = relay.relay_urls {
            if urls.is_empty() || urls.len()>8 { return Err(error("invalid_argument")); }
            let map = RelayMap::empty();
            for value in urls {
                let url = RelayUrl::from_str(&value).map_err(|_| error("invalid_argument"))?;
                if url.scheme()!="https" || !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() { return Err(error("invalid_argument")); }
                let mut config = RelayConfig::new(url.clone(),None);
                if let Some(token) = &relay.relay_token { config = config.with_auth_token(token.clone()); }
                map.insert(url,Arc::new(config));
            }
            builder = builder.relay_mode(RelayMode::Custom(map));
        }
        let endpoint = builder.bind().await.map_err(|_|stage("bind"))?;
        Ok(Self{endpoint})
    }
    #[wasm_bindgen(js_name = endpointId)]
    pub fn endpoint_id(&self) -> String { self.endpoint.id().to_string() }
    pub fn ticket(&self) -> String { EndpointTicket::new(self.endpoint.addr()).to_string() }
    #[wasm_bindgen(js_name = updateRelay)]
    pub async fn update_relay(&self,url:&str,token:&str)->Result<(),JsValue>{
        let url=RelayUrl::from_str(url).map_err(|_|error("invalid_argument"))?;
        let config=RelayConfig::new(url.clone(),None).with_auth_token(token.to_owned());
        self.endpoint.insert_relay(url,Arc::new(config)).await;Ok(())
    }
    pub async fn online(&self) { self.endpoint.online().await; }
    pub async fn connect(&self, ticket: &str, expected_id: &str) -> Result<IrohStream,JsValue> {
        let ticket = EndpointTicket::decode_string(ticket).map_err(|_| error("invalid_argument"))?;
        if ticket.endpoint_addr().id.to_string()!=expected_id { return Err(error("identity_mismatch")); }
        let connection = self.endpoint.connect(ticket.endpoint_addr().clone(),ALPN).await.map_err(|_|stage("connect"))?;
        if connection.remote_id().to_string()!=expected_id { connection.close(1u32.into(),b""); return Err(error("identity_mismatch")); }
        let (send,recv) = connection.open_bi().await.map_err(|_|stage("open_stream"))?;
        Ok(IrohStream::new(connection,send,recv))
    }
    pub async fn accept(&self) -> Result<Option<IrohStream>,JsValue> {
        loop {
            let Some(incoming)=self.endpoint.accept().await else{return Ok(None)};
            let attempt=n0_future::time::timeout(std::time::Duration::from_secs(10),async move{
                let connection=incoming.await.map_err(transport)?;
                let mut guard=PendingConnection{connection,accepted:false};
                let(send,recv)=guard.connection.accept_bi().await.map_err(transport)?;
                guard.accepted=true;Ok::<_,JsValue>(IrohStream::new(guard.connection.clone(),send,recv))
            }).await;
            if let Ok(Ok(stream))=attempt{return Ok(Some(stream))}
        }
    }
    pub async fn close(&self) { self.endpoint.close().await; }
}

struct PendingConnection{connection:Connection,accepted:bool}
impl Drop for PendingConnection{fn drop(&mut self){if !self.accepted{self.connection.close(1u32.into(),b"");}}}

#[wasm_bindgen]
pub struct IrohStream { connection: Connection, send: Mutex<SendStream>, recv: Mutex<RecvStream> }
impl IrohStream {
    fn new(connection: Connection, send: SendStream, recv: RecvStream) -> Self {
        connection.set_max_concurrent_bi_streams(1u32.into());
        connection.set_max_concurrent_uni_streams(0u32.into());
        connection.set_receive_window((512u32*1024).into());
        Self{connection,send:Mutex::new(send),recv:Mutex::new(recv)}
    }
}
#[wasm_bindgen]
impl IrohStream {
    #[wasm_bindgen(js_name = remoteEndpointId)]
    pub fn remote_endpoint_id(&self) -> String { self.connection.remote_id().to_string() }
    pub async fn read(&self) -> Result<Vec<u8>,JsValue> {
        let mut stream = self.recv.try_lock().map_err(|_| error("invalid_argument"))?;
        let mut bytes = vec![0u8;64*1024];
        let size = stream.read(&mut bytes).await.map_err(transport)?.unwrap_or(0);
        bytes.truncate(size); Ok(bytes)
    }
    pub async fn write(&self, bytes: Vec<u8>) -> Result<(),JsValue> {
        if bytes.len()>128*1024 { return Err(error("resource_exhausted")); }
        let mut stream = self.send.try_lock().map_err(|_| error("resource_exhausted"))?;
        stream.write_all(&bytes).await.map_err(transport)
    }
    pub async fn close(&self) -> Result<(),JsValue> {
        let result=self.send.lock().await.finish().map_err(transport);
        self.connection.close(0u32.into(),b"");result
    }
    pub fn abort(&self) { self.connection.close(1u32.into(),b""); }
}
