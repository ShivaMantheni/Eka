"""
Cryptographic utilities for secure password storage

This module provides password encryption/decryption using Fernet (AES-128)
symmetric encryption for securing passwords at rest in the database.

Features:
- Automatic master key generation and storage
- Fernet (AES-128) symmetric encryption
- Environment variable and file-based key management
- Database backup utilities
- Password sanitization for logs

Usage:
    from crypto_utils import encrypt_password, decrypt_password

    # Encrypt password before storing
    encrypted = encrypt_password("my_secret_password")

    # Decrypt password when needed
    plaintext = decrypt_password(encrypted)
"""

import os
import shutil
import datetime
from pathlib import Path
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
import base64
import re


class PasswordEncryption:
    """
    Handles password encryption/decryption using Fernet (AES-128)

    Fernet provides authenticated encryption with:
    - AES-128 encryption in CBC mode
    - HMAC-SHA256 for authentication
    - Timestamp for key rotation support
    """

    def __init__(self, master_key: str = None):
        """
        Initialize encryption with master key

        Args:
            master_key: Master encryption key (if None, reads from env or generates)
        """
        if master_key is None:
            # Try to load from environment variable first
            master_key = os.getenv('DUT_AUTOMATION_MASTER_KEY')

            if not master_key:
                # Try to load from secure file
                key_file = Path(__file__).parent / 'data' / '.master_key'

                if key_file.exists():
                    with open(key_file, 'r') as f:
                        master_key = f.read().strip()
                else:
                    # Generate new key and save
                    master_key = Fernet.generate_key().decode('utf-8')

                    # Create data directory if it doesn't exist
                    key_file.parent.mkdir(parents=True, exist_ok=True)

                    # Save master key
                    with open(key_file, 'w') as f:
                        f.write(master_key)

                    # Set restrictive permissions (owner read/write only)
                    os.chmod(key_file, 0o600)

                    print(f"⚠️  Generated new master encryption key")
                    print(f"⚠️  Location: {key_file}")
                    print(f"⚠️  BACKUP THIS FILE IMMEDIATELY - Lost key = lost passwords")
                    print(f"⚠️  Backup command:")
                    print(f"     sudo cp {key_file} /root/backups/master_key_$(date +%Y%m%d).key")
                    print(f"     sudo chmod 400 /root/backups/master_key_*.key")

        # Initialize Fernet cipher
        self.cipher = Fernet(master_key.encode() if isinstance(master_key, str) else master_key)

    def encrypt(self, plaintext: str) -> str:
        """
        Encrypt plaintext password

        Args:
            plaintext: Password to encrypt

        Returns:
            Base64-encoded encrypted password
        """
        if not plaintext:
            return ""

        try:
            encrypted = self.cipher.encrypt(plaintext.encode('utf-8'))
            return encrypted.decode('utf-8')
        except Exception as e:
            print(f"Encryption error: {str(e)}")
            return ""

    def decrypt(self, encrypted: str) -> str:
        """
        Decrypt encrypted password

        Args:
            encrypted: Base64-encoded encrypted password

        Returns:
            Decrypted plaintext password
        """
        if not encrypted:
            return ""

        try:
            decrypted = self.cipher.decrypt(encrypted.encode('utf-8'))
            return decrypted.decode('utf-8')
        except Exception as e:
            # If decryption fails, might be plain text (migration in progress)
            # Return as-is but log warning
            print(f"Decryption error (might be plain text): {str(e)}")
            return encrypted

    @staticmethod
    def generate_key() -> str:
        """
        Generate new Fernet encryption key

        Returns:
            Base64-encoded Fernet key
        """
        return Fernet.generate_key().decode('utf-8')


# ============================================================================
# GLOBAL INSTANCE (Singleton Pattern)
# ============================================================================

_password_encryption = None


def get_password_encryption() -> PasswordEncryption:
    """
    Get or create global password encryption instance

    Returns:
        Singleton PasswordEncryption instance
    """
    global _password_encryption
    if _password_encryption is None:
        _password_encryption = PasswordEncryption()
    return _password_encryption


def encrypt_password(password: str) -> str:
    """
    Convenience function to encrypt password

    Args:
        password: Plain text password

    Returns:
        Encrypted password
    """
    return get_password_encryption().encrypt(password)


def decrypt_password(encrypted_password: str) -> str:
    """
    Convenience function to decrypt password

    Args:
        encrypted_password: Encrypted password

    Returns:
        Plain text password
    """
    return get_password_encryption().decrypt(encrypted_password)


# ============================================================================
# LOG SANITIZATION
# ============================================================================

def sanitize_log(log_text: str, passwords: list = None) -> str:
    """
    Remove sensitive information from logs

    Args:
        log_text: Raw log text
        passwords: List of passwords to redact

    Returns:
        Sanitized log text with passwords removed
    """
    if not log_text:
        return ""

    sanitized = log_text

    # Redact each password
    if passwords:
        for password in passwords:
            if password:
                sanitized = sanitized.replace(password, "***REDACTED***")

    # Redact common password patterns
    # SCP password in command: scp user@host:path .
    # Following password prompt response
    sanitized = re.sub(
        r'(password:\s*)[^\s\n]+',
        r'\1***REDACTED***',
        sanitized,
        flags=re.IGNORECASE
    )

    # Redact passwords in command strings
    sanitized = re.sub(
        r'(-p\s+)[^\s]+',
        r'\1***REDACTED***',
        sanitized
    )

    # Redact anything that looks like a long token/key
    sanitized = re.sub(
        r'\b([A-Za-z0-9_-]{40,})\b',
        lambda m: m.group(1)[:8] + '***' if len(m.group(1)) > 40 else m.group(1),
        sanitized
    )

    return sanitized


# ============================================================================
# DATABASE BACKUP UTILITIES
# ============================================================================

def backup_database(db_path: Path = None, backup_dir: Path = None) -> Path:
    """
    Create timestamped backup of database

    Args:
        db_path: Path to database file (default: data/dut_automation.db)
        backup_dir: Backup directory (default: data/backups)

    Returns:
        Path to backup file

    Backups stored as: backups/db_YYYYMMDD_HHMMSS.db
    """
    if db_path is None:
        db_path = Path(__file__).parent / "data" / "dut_automation.db"

    if backup_dir is None:
        backup_dir = Path(__file__).parent / "data" / "backups"

    # Create backup directory
    backup_dir.mkdir(parents=True, exist_ok=True)

    # Create timestamped backup
    timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_path = backup_dir / f"db_{timestamp}.db"

    # Copy database
    shutil.copy2(db_path, backup_path)

    print(f"✓ Database backed up to: {backup_path}")

    # Clean old backups (keep last 30 days)
    cleanup_old_backups(backup_dir, days=30)

    return backup_path


def cleanup_old_backups(backup_dir: Path, days: int = 30):
    """
    Delete backups older than specified days

    Args:
        backup_dir: Backup directory
        days: Number of days to retain backups
    """
    import time

    now = time.time()
    cutoff = now - (days * 86400)  # Convert days to seconds

    deleted_count = 0

    for backup_file in backup_dir.glob("db_*.db"):
        if backup_file.stat().st_mtime < cutoff:
            backup_file.unlink()
            deleted_count += 1
            print(f"✓ Deleted old backup: {backup_file.name}")

    if deleted_count > 0:
        print(f"✓ Cleaned up {deleted_count} old backup(s)")


# ============================================================================
# MASTER KEY MANAGEMENT
# ============================================================================

def get_master_key_path() -> Path:
    """
    Get path to master encryption key file

    Returns:
        Path to master key file
    """
    return Path(__file__).parent / "data" / ".master_key"


def backup_master_key(backup_path: Path = None) -> Path:
    """
    Backup master encryption key to secure location

    Args:
        backup_path: Target backup path (default: data/backups/master_key_YYYYMMDD.key)

    Returns:
        Path to backup file
    """
    key_file = get_master_key_path()

    if not key_file.exists():
        raise FileNotFoundError(f"Master key not found at: {key_file}")

    if backup_path is None:
        backup_dir = Path(__file__).parent / "data" / "backups"
        backup_dir.mkdir(parents=True, exist_ok=True)
        timestamp = datetime.datetime.now().strftime("%Y%m%d")
        backup_path = backup_dir / f"master_key_{timestamp}.key"

    # Copy master key
    shutil.copy2(key_file, backup_path)

    # Set restrictive permissions
    os.chmod(backup_path, 0o400)  # Read-only

    print(f"✓ Master key backed up to: {backup_path}")
    print(f"  Permissions: 400 (read-only)")

    return backup_path


def verify_master_key() -> bool:
    """
    Verify master encryption key exists and is readable

    Returns:
        True if key is valid, False otherwise
    """
    key_file = get_master_key_path()

    if not key_file.exists():
        print(f"✗ Master key not found at: {key_file}")
        return False

    try:
        with open(key_file, 'r') as f:
            key_data = f.read().strip()

        # Try to initialize Fernet with the key
        Fernet(key_data.encode())

        print(f"✓ Master key verified: {key_file}")
        return True

    except Exception as e:
        print(f"✗ Master key verification failed: {str(e)}")
        return False


# ============================================================================
# TESTING / VERIFICATION
# ============================================================================

def test_encryption():
    """
    Test password encryption/decryption functionality

    Returns:
        True if test passes, False otherwise
    """
    print("=" * 60)
    print("TESTING PASSWORD ENCRYPTION")
    print("=" * 60)

    test_passwords = [
        "test123",
        "ComplexP@ssw0rd!",
        "🔒 Unicode パスワード",
        "",  # Empty password
    ]

    all_passed = True

    for password in test_passwords:
        try:
            # Encrypt
            encrypted = encrypt_password(password)

            # Decrypt
            decrypted = decrypt_password(encrypted)

            # Verify
            if password == decrypted:
                print(f"✓ PASS: '{password[:20]}...' encrypted/decrypted successfully")
            else:
                print(f"✗ FAIL: Password mismatch")
                print(f"    Original: {password}")
                print(f"    Decrypted: {decrypted}")
                all_passed = False

        except Exception as e:
            print(f"✗ FAIL: Exception for '{password[:20]}...': {str(e)}")
            all_passed = False

    print("=" * 60)
    if all_passed:
        print("✓✓✓ ALL TESTS PASSED ✓✓✓")
    else:
        print("✗✗✗ SOME TESTS FAILED ✗✗✗")
    print("=" * 60)

    return all_passed


if __name__ == "__main__":
    """
    Run tests when executed directly
    """
    # Verify master key
    verify_master_key()

    # Run encryption tests
    test_encryption()

    # Show backup commands
    print("\n" + "=" * 60)
    print("BACKUP COMMANDS")
    print("=" * 60)
    key_file = get_master_key_path()
    print(f"\n# Backup master key:")
    print(f"sudo cp {key_file} /root/backups/master_key_$(date +%Y%m%d).key")
    print(f"sudo chmod 400 /root/backups/master_key_*.key")
    print(f"\n# Backup database:")
    print(f"python -c \"from crypto_utils import backup_database; backup_database()\"")
    print("=" * 60)
