import os
import sys
import json
import struct
import base64
import hashlib

def read_varint(data, pos):
    val = 0
    shift = 0
    while True:
        if pos >= len(data):
            raise ValueError("Unexpected end of data parsing varint")
        b = data[pos]
        val |= (b & 0x7f) << shift
        pos += 1
        if not (b & 0x80):
            break
        shift += 7
    return val, pos

def extract_pubkey_from_crx3(crx_path):
    with open(crx_path, 'rb') as f:
        data = f.read(4096)
        if len(data) < 12:
            raise ValueError("File too short")
        if data[:4] != b'Cr24':
            raise ValueError("Invalid magic number (expected Cr24)")
        version = int.from_bytes(data[4:8], byteorder='little')
        if version != 3:
            raise ValueError(f"Expected CRX version 3, got {version}")
        header_len = int.from_bytes(data[8:12], byteorder='little')
        
        pos = 12
        # First field: sha256_with_rsa (key 0x0a) or sha256_with_ecdsa (key 0x12)
        key = data[pos]
        if key not in (0x0a, 0x12):
            raise ValueError(f"Expected field 1 (0x0a) or field 2 (0x12), got {hex(key)}")
        pos += 1
        
        # Read field length
        field_len, pos = read_varint(data, pos)
        
        # Inside AsymmetricKeyProof, public_key is field 1 (key 0x0a)
        if data[pos] != 0x0a:
            raise ValueError(f"Expected public_key key 0x0a, got {hex(data[pos])}")
        pos += 1
        
        # Read public_key length
        pubkey_len, pos = read_varint(data, pos)
        
        # Read public key bytes
        pubkey = data[pos:pos+pubkey_len]
        return pubkey

def get_extension_id(pubkey_bytes):
    sha256 = hashlib.sha256(pubkey_bytes).hexdigest()
    mapping = str.maketrans('0123456789abcdef', 'abcdefghijklmnop')
    return sha256[:32].translate(mapping)

def main():
    print("=" * 60)
    print(" TimeTracker — Stable Extension ID Configurator")
    print("=" * 60)
    
    workspace_dir = os.path.dirname(os.path.abspath(__file__))
    parent_dir = os.path.dirname(workspace_dir)
    
    # Check in both workspace and parent directories
    crx_path = os.path.join(workspace_dir, "TimeTracker.crx")
    if not os.path.exists(crx_path):
        crx_path = os.path.join(parent_dir, "TimeTracker.crx")
        
    if not os.path.exists(crx_path):
        print(f"Error: Could not find packed CRX file at: {crx_path}")
        print("\nPlease follow these simple steps to generate it:")
        print("1. Open Google Chrome on the computer where the extension is loaded.")
        print("2. Navigate to: chrome://extensions/")
        print("3. Enable 'Developer mode' using the toggle in the top-right corner.")
        print("4. Click the 'Pack extension' button in the top-left.")
        print("5. Set 'Extension root directory' by browsing and selecting:")
        print(f"   {workspace_dir}")
        print("6. Leave the 'Private key file' field empty.")
        print("7. Click the 'Pack extension' button to complete packing.")
        print(f"   This will generate 'TimeTracker.crx' and 'TimeTracker.pem' in {parent_dir}")
        print("\n8. Once done, run this script again to configure the stable ID!")
        input("\nPress Enter to exit...")
        return
        
    try:
        print(f"Found CRX file: {crx_path}")
        print("Extracting public key...")
        pubkey = extract_pubkey_from_crx3(crx_path)
        
        key_base64 = base64.b64encode(pubkey).decode('utf-8')
        extension_id = get_extension_id(pubkey)
        
        manifest_path = os.path.join(workspace_dir, "manifest.json")
        if not os.path.exists(manifest_path):
            print(f"Error: manifest.json not found at {manifest_path}")
            return
            
        print("Updating manifest.json with stable key...")
        with open(manifest_path, 'r', encoding='utf-8') as f:
            manifest = json.load(f)
            
        manifest['key'] = key_base64
        
        with open(manifest_path, 'w', encoding='utf-8') as f:
            json.dump(manifest, f, indent=2)
            
        print("\n" + "=" * 60)
        print(" SUCCESS!")
        print("=" * 60)
        print(f"1. manifest.json has been updated with the stable key.")
        print(f"2. Your new stable Extension ID is: {extension_id}")
        print("\nACTION REQUIRED IN GOOGLE CLOUD CONSOLE:")
        print("Please update your Google Cloud OAuth Client ID configuration:")
        print("  - Go to https://console.cloud.google.com/apis/credentials")
        print("  - Find your OAuth 2.0 Client ID under 'OAuth 2.0 Client IDs' (Chrome extension type).")
        print("  - Click Edit (pencil icon).")
        print(f"  - Replace the 'Item ID' field with: {extension_id}")
        print("  - Save changes.")
        print("\n3. Once updated, you can load this extension folder unpacked on ANY computer or browser")
        print("   (Chrome, Edge, Brave, etc.) and it will sign in successfully!")
        print("=" * 60)
        
    except Exception as e:
        print(f"\nError configuring stable ID: {e}")
        
    input("\nPress Enter to exit...")

if __name__ == "__main__":
    main()
