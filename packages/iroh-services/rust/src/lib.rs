use std::str::FromStr;
use wasm_bindgen::prelude::*;
use iroh::{EndpointId,SecretKey};
use iroh_services::{ApiSecret,caps::{Caps,Cap,RelayCap}};
use rcan::{Rcan,Expires};

fn error() -> JsValue { js_sys::Error::new("invalid_argument").into() }

#[wasm_bindgen(js_name = issueRelayLease)]
pub fn issue_relay_lease(api_secret:&str,endpoint_id:&str,ttl_seconds:u32)->Result<String,JsValue> {
    if !(60..=86400).contains(&ttl_seconds) { return Err(error()); }
    let api = ApiSecret::from_str(api_secret).map_err(|_|error())?;
    let audience = EndpointId::from_str(endpoint_id).map_err(|_|error())?;
    let token = iroh_services::caps::create_api_token_from_secret_key(api.secret,audience,std::time::Duration::from_secs(ttl_seconds as u64),Caps::new([Cap::Relay(RelayCap::Use)])).map_err(|_|error())?;
    let expires_at = match token.expires() { Expires::At(seconds)=>seconds*1000,Expires::Never=>return Err(error()) };
    Ok(serde_json::json!({"relayToken":data_encoding::BASE32_NOPAD.encode(&token.encode()).to_ascii_lowercase(),"endpointId":audience.to_string(),"expiresAt":expires_at,"scope":"relay:use"}).to_string())
}

#[wasm_bindgen(js_name = inspectRelayLease)]
pub fn inspect_relay_lease(value:&str)->Result<String,JsValue> {
    if value.len()>16384 {return Err(error());}
    let bytes = data_encoding::BASE32_NOPAD.decode(value.to_ascii_uppercase().as_bytes()).map_err(|_|error())?;
    // The upstream decoder verifies the signature before returning the payload.
    let token:Rcan<Caps> = Rcan::decode(&bytes).map_err(|_|error())?;
    let expires_at = match token.expires() {Expires::At(seconds)=>Some(seconds*1000),Expires::Never=>None};
    Ok(serde_json::json!({"audience":token.audience().to_bytes().iter().map(|byte|format!("{byte:02x}")).collect::<String>(),"scope":token.capability().to_strings(),"expiresAt":expires_at}).to_string())
}

#[wasm_bindgen(js_name = publicKeyFromPrivate)]
pub fn public_key_from_private(bytes:Vec<u8>)->Result<String,JsValue> {
    let bytes:[u8;32] = bytes.try_into().map_err(|_|error())?;
    Ok(SecretKey::from_bytes(&bytes).public().to_string())
}

#[wasm_bindgen(js_name = createTicket)]
pub fn create_ticket(endpoint_id:&str,relays_json:&str)->Result<String,JsValue>{
    let id=EndpointId::from_str(endpoint_id).map_err(|_|error())?;
    let relays:Vec<String>=serde_json::from_str(relays_json).map_err(|_|error())?;
    if relays.is_empty()||relays.len()>8{return Err(error());}
    let mut addr=iroh::EndpointAddr::new(id);
    for value in relays{let relay=iroh::RelayUrl::from_str(&value).map_err(|_|error())?;if relay.scheme()!="https"||!relay.username().is_empty()||relay.password().is_some()||relay.query().is_some()||relay.fragment().is_some(){return Err(error());}addr.addrs.insert(iroh::TransportAddr::Relay(relay));}
    Ok(iroh_tickets::endpoint::EndpointTicket::new(addr).to_string())
}
