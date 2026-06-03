# Eka Application - AccessHub SSO Integration Requirements

## Overview
This document defines how Eka application integrates with AccessHub for Single Sign-On (SSO) authentication and user management.

---

## 1. SSO Authentication Flow

### 1.1 Initial Login Process
```
User → Eka Login Page → AccessHub Authentication → Token Generation → Eka Dashboard
```

**Step-by-step:**
1. User enters credentials on Eka login page
2. Eka sends authentication request to AccessHub
3. AccessHub validates credentials
4. AccessHub returns access token + user data
5. Eka stores token and creates local session
6. User redirected to dashboard

---

## 2. Authentication Request (Eka → AccessHub)

### 2.1 Login Endpoint
```
POST /api/auth/login.php
```

### 2.2 Request Parameters
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `email` | string | Yes | User's email address |
| `password` | string | Yes | User's password |
| `app_name` | string | Yes | Application name (e.g., "Eka") |

### 2.3 Request Payload Example
```json
{
  "email": "balamurali.kumar@palcnetworks.com",
  "password": "user_password_here",
  "app_name": "Eka"
}
```

### 2.4 cURL Example
```bash
curl -X POST "http://accesshub.example.com/api/auth/login.php" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "balamurali.kumar@palcnetworks.com",
    "password": "user_password",
    "app_name": "Eka"
  }'
```

---

## 3. Authentication Response (AccessHub → Eka)

### 3.1 Success Response (200 OK)
```json
{
  "success": true,
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "token_type": "Bearer",
  "expires_in": 86400,
  "user": {
    "user_id": 1,
    "employee_id": "1156",
    "first_name": "Balamurali",
    "last_name": "Santhakumar",
    "display_name": "Balamurali Santhakumar",
    "email": "balamurali.kumar@palcnetworks.com",
    "designation": "Software Engineer",
    "department": "Engineering",
    "location": "Chennai",
    "status": "Active",
    "role": "admin"
  }
}
```

### 3.2 Error Response (401 Unauthorized)
```json
{
  "success": false,
  "error": "Invalid email or password"
}
```

### 3.3 Error Response (403 Forbidden - User Not Assigned)
```json
{
  "success": false,
  "error": "User not assigned to this application"
}
```

### 3.4 Error Response (403 Forbidden - Inactive User)
```json
{
  "success": false,
  "error": "User account is inactive"
}
```

---

## 4. User Role Determination

### 4.1 Role Types (Simplified)
Eka uses **only 2 roles**:

| Role | Description | Permissions |
|------|-------------|-------------|
| `admin` | Administrator | Full access to all users and system settings |
| `user` | Normal User | Access only to their own data and tests |

### 4.2 Role Mapping Logic
AccessHub determines role based on application roles:

```python
# Pseudo-code for role determination
if user has application_role "EkaAdmin" or "Admin":
    role = "admin"
else:
    role = "user"
```

### 4.3 Role Assignment Rules
- **Admin users**: Can view/edit all users' data, test results, reports
- **Normal users**: Can only view/edit their own test scripts, results, logs
- Role is sent in authentication response payload
- Role is stored in database and session

---

## 5. Access Token Management

### 5.1 Token Format
- **Type**: JWT (JSON Web Token)
- **Algorithm**: HS256
- **Expiry**: 24 hours (86400 seconds)
- **Structure**: `header.payload.signature`

### 5.2 Token Payload (Decoded)
```json
{
  "user_id": 1,
  "employee_id": "1156",
  "email": "balamurali.kumar@palcnetworks.com",
  "role": "admin",
  "app_name": "Eka",
  "iat": 1715529600,
  "exp": 1715616000
}
```

### 5.3 Token Storage in Eka

#### Database Storage
```sql
CREATE TABLE user_sessions (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT NOT NULL,
    access_token TEXT NOT NULL,
    token_expires_at DATETIME NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_activity TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    ip_address VARCHAR(45),
    user_agent VARCHAR(255),
    is_active BOOLEAN DEFAULT TRUE,
    INDEX idx_user_id (user_id),
    INDEX idx_token_expiry (token_expires_at),
    INDEX idx_active (is_active)
);
```

#### Client-Side Storage
Store in **HTTP-only secure cookie**:
```
Set-Cookie: eka_access_token=eyJhbGc...;
            HttpOnly;
            Secure;
            SameSite=Strict;
            Max-Age=86400;
            Path=/
```

**Why HTTP-only cookie?**
- Prevents JavaScript access (XSS protection)
- Automatically sent with every request
- Secure flag ensures HTTPS only
- SameSite prevents CSRF attacks

---

## 6. Token Validation Process

### 6.1 Validation on Every Request
```
User Request → Eka Backend → Extract Token → Validate Token → Allow/Deny Access
```

### 6.2 Token Validation Steps

**Step 1: Extract Token from Cookie**
```python
token = request.cookies.get('eka_access_token')
if not token:
    return redirect_to_login()
```

**Step 2: Verify Token with AccessHub**
```
POST /api/auth/verify.php
Content-Type: application/json

{
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "app_name": "Eka"
}
```

**Step 3: AccessHub Response**
```json
{
  "valid": true,
  "user": {
    "user_id": 1,
    "email": "balamurali.kumar@palcnetworks.com",
    "role": "admin",
    "status": "Active"
  }
}
```

**If token is invalid or expired:**
```json
{
  "valid": false,
  "error": "Token expired or invalid"
}
```

### 6.3 Local Token Validation (Faster Alternative)
Instead of calling AccessHub on every request, validate locally:

```python
import jwt
import datetime

def validate_token_locally(token):
    try:
        # Decode token using shared secret
        payload = jwt.decode(
            token,
            secret_key='SHARED_SECRET_WITH_ACCESSHUB',
            algorithms=['HS256']
        )

        # Check expiry
        if payload['exp'] < datetime.datetime.now().timestamp():
            return None, "Token expired"

        # Check if user is still active in database
        user = db.query("SELECT * FROM users WHERE user_id = ?", [payload['user_id']])
        if not user or user['status'] != 'Active':
            return None, "User inactive"

        return payload, None
    except jwt.InvalidTokenError:
        return None, "Invalid token"
```

**Validation frequency:**
- Local validation: Every request (fast, no network call)
- Remote validation (AccessHub): Every 1 hour or on critical operations

---

## 7. User Data Storage in Eka Database

### 7.1 Users Table Schema
```sql
CREATE TABLE users (
    id INT PRIMARY KEY AUTO_INCREMENT,
    accesshub_user_id INT NOT NULL UNIQUE,
    employee_id VARCHAR(50) NOT NULL UNIQUE,
    email VARCHAR(255) NOT NULL UNIQUE,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    display_name VARCHAR(200) NOT NULL,
    designation VARCHAR(100),
    department VARCHAR(100),
    location VARCHAR(100),
    role ENUM('admin', 'user') DEFAULT 'user',
    status ENUM('Active', 'Inactive') DEFAULT 'Active',
    last_login TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    INDEX idx_email (email),
    INDEX idx_employee_id (employee_id),
    INDEX idx_role (role),
    INDEX idx_status (status)
);
```

### 7.2 Data Sync on Login
When user logs in successfully:

```python
def save_user_data(auth_response):
    user_data = auth_response['user']

    # Check if user exists
    existing_user = db.query(
        "SELECT id FROM users WHERE email = ?",
        [user_data['email']]
    )

    if existing_user:
        # Update existing user
        db.execute("""
            UPDATE users SET
                first_name = ?,
                last_name = ?,
                display_name = ?,
                designation = ?,
                department = ?,
                location = ?,
                role = ?,
                status = ?,
                last_login = NOW(),
                updated_at = NOW()
            WHERE email = ?
        """, [
            user_data['first_name'],
            user_data['last_name'],
            user_data['display_name'],
            user_data['designation'],
            user_data['department'],
            user_data['location'],
            user_data['role'],
            user_data['status'],
            user_data['email']
        ])
        user_id = existing_user['id']
    else:
        # Create new user
        user_id = db.execute("""
            INSERT INTO users (
                accesshub_user_id, employee_id, email,
                first_name, last_name, display_name,
                designation, department, location,
                role, status, last_login
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
        """, [
            user_data['user_id'],
            user_data['employee_id'],
            user_data['email'],
            user_data['first_name'],
            user_data['last_name'],
            user_data['display_name'],
            user_data['designation'],
            user_data['department'],
            user_data['location'],
            user_data['role'],
            user_data['status']
        ])

    return user_id
```

---

## 8. Session Management (Avoid Repeated Login)

### 8.1 Session Flow
```
Login → Store Token in Cookie + DB → Token Valid? → Continue Session
                                    → Token Expired? → Redirect to Login
```

### 8.2 Automatic Session Resume
On every page load, Eka checks:

```python
def check_session():
    # Get token from cookie
    token = request.cookies.get('eka_access_token')

    if not token:
        return redirect('/login')

    # Validate token locally (fast)
    payload, error = validate_token_locally(token)

    if error:
        # Token invalid/expired - clear session
        response = redirect('/login')
        response.delete_cookie('eka_access_token')
        return response

    # Token valid - continue
    # Load user data from database
    user = get_user_by_id(payload['user_id'])

    # Store in request context for easy access
    request.current_user = user

    return None  # Continue to requested page
```

### 8.3 Session Expiry Handling
- **Token expires**: User redirected to login
- **User becomes inactive**: Token invalidated immediately
- **Manual logout**: Token deleted from cookie and database

---

## 9. Authorization & Access Control

### 9.1 Admin Access Control
```python
def require_admin(func):
    def wrapper(*args, **kwargs):
        if not request.current_user:
            return redirect('/login')

        if request.current_user['role'] != 'admin':
            return error_response('Access denied. Admin only.', 403)

        return func(*args, **kwargs)
    return wrapper

# Usage
@app.route('/admin/users')
@require_admin
def list_all_users():
    users = db.query("SELECT * FROM users")
    return render_template('admin_users.html', users=users)
```

### 9.2 User Access Control (Own Data Only)
```python
def require_user(func):
    def wrapper(*args, **kwargs):
        if not request.current_user:
            return redirect('/login')

        # User can only access their own data
        requested_user_id = kwargs.get('user_id')
        if requested_user_id and requested_user_id != request.current_user['id']:
            if request.current_user['role'] != 'admin':
                return error_response('Access denied', 403)

        return func(*args, **kwargs)
    return wrapper

# Usage
@app.route('/tests/<int:user_id>')
@require_user
def view_user_tests(user_id):
    # Normal users see only their tests
    # Admins can see any user's tests
    tests = get_tests_by_user(user_id)
    return render_template('tests.html', tests=tests)
```

---

## 10. Complete Integration Code Examples

### 10.1 Login Implementation (Python/Flask)
```python
from flask import Flask, request, jsonify, make_response, redirect
import requests
import jwt
import datetime

app = Flask(__name__)

@app.route('/login', methods=['POST'])
def login():
    email = request.json.get('email')
    password = request.json.get('password')

    if not email or not password:
        return jsonify({'error': 'Email and password required'}), 400

    # Call AccessHub authentication API
    try:
        auth_response = requests.post(
            'http://accesshub.example.com/api/auth/login.php',
            json={
                'email': email,
                'password': password,
                'app_name': 'Eka'
            },
            timeout=10
        )

        if auth_response.status_code != 200:
            return jsonify({'error': 'Authentication failed'}), 401

        data = auth_response.json()

        if not data.get('success'):
            return jsonify({'error': data.get('error', 'Authentication failed')}), 401

        # Save user data to database
        user_id = save_user_data(data)

        # Save session
        save_session(user_id, data['access_token'], data['expires_in'])

        # Set cookie
        response = make_response(jsonify({
            'success': True,
            'user': data['user']
        }))

        response.set_cookie(
            'eka_access_token',
            value=data['access_token'],
            max_age=data['expires_in'],
            httponly=True,
            secure=True,
            samesite='Strict'
        )

        return response

    except requests.RequestException as e:
        return jsonify({'error': 'Authentication service unavailable'}), 503
```

### 10.2 Token Validation Middleware
```python
from functools import wraps

def require_auth(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        token = request.cookies.get('eka_access_token')

        if not token:
            return redirect('/login')

        # Validate token
        payload, error = validate_token_locally(token)

        if error:
            response = make_response(redirect('/login'))
            response.delete_cookie('eka_access_token')
            return response

        # Load user from database
        user = get_user_by_id(payload['user_id'])

        if not user or user['status'] != 'Active':
            response = make_response(redirect('/login'))
            response.delete_cookie('eka_access_token')
            return response

        # Attach user to request
        request.current_user = user

        return f(*args, **kwargs)

    return decorated_function

# Usage
@app.route('/dashboard')
@require_auth
def dashboard():
    return render_template('dashboard.html', user=request.current_user)
```

### 10.3 Logout Implementation
```python
@app.route('/logout', methods=['POST'])
def logout():
    token = request.cookies.get('eka_access_token')

    if token:
        # Deactivate session in database
        db.execute(
            "UPDATE user_sessions SET is_active = FALSE WHERE access_token = ?",
            [token]
        )

    # Clear cookie
    response = make_response(redirect('/login'))
    response.delete_cookie('eka_access_token')

    return response
```

---

## 11. Testing & Verification Checklist

### 11.1 Authentication Testing
- [ ] Test login with valid credentials
- [ ] Test login with invalid credentials
- [ ] Test login with inactive user
- [ ] Test login with user not assigned to Eka
- [ ] Verify token is stored in cookie
- [ ] Verify user data is saved to database

### 11.2 Token Validation Testing
- [ ] Test accessing protected page with valid token
- [ ] Test accessing protected page with expired token
- [ ] Test accessing protected page without token
- [ ] Test accessing protected page with invalid token
- [ ] Verify expired token redirects to login
- [ ] Verify inactive user cannot access even with valid token

### 11.3 Authorization Testing
- [ ] Admin can access all users' data
- [ ] Normal user can only access their own data
- [ ] Normal user cannot access admin pages
- [ ] Normal user attempting admin access gets 403 error

### 11.4 Session Persistence Testing
- [ ] User logs in once
- [ ] Close browser and reopen (if cookie persists)
- [ ] User still logged in (no re-authentication needed)
- [ ] Token expires after 24 hours
- [ ] User redirected to login after expiry

---

## 12. Security Considerations

### 12.1 Token Security
- Store tokens in HTTP-only cookies (not localStorage)
- Use HTTPS in production (Secure flag on cookies)
- Implement CSRF protection with SameSite cookie attribute
- Rotate tokens on sensitive operations

### 12.2 Password Security
- Passwords never stored in Eka database
- All password validation done by AccessHub
- Use HTTPS for login requests to prevent sniffing

### 12.3 Session Security
- Implement session timeout (24 hours)
- Invalidate sessions on password change
- Log all authentication attempts
- Implement rate limiting on login endpoint (max 5 attempts per minute)

---

## 13. Error Scenarios & Handling

| Scenario | Response | Action |
|----------|----------|--------|
| Invalid credentials | 401 Unauthorized | Show "Invalid email or password" |
| User not assigned to Eka | 403 Forbidden | Show "Access denied" |
| User inactive | 403 Forbidden | Show "Account disabled" |
| Token expired | 401 Unauthorized | Redirect to login |
| AccessHub unavailable | 503 Service Unavailable | Show "Service temporarily unavailable" |
| Network timeout | 504 Gateway Timeout | Retry with exponential backoff |

---

## 14. Summary - Key Requirements

### Required from AccessHub:
1. **POST /api/auth/login.php** - Authenticate user and return access token
2. **POST /api/auth/verify.php** - Validate access token
3. **JWT secret key** - Shared between AccessHub and Eka for token validation

### Required in Eka:
1. **Login page** - Collect email and password
2. **Authentication handler** - Call AccessHub login API
3. **Token storage** - Save token in HTTP-only cookie and database
4. **Token validation** - Check token validity on every request
5. **User database** - Store user profile and role
6. **Session management** - Maintain login state
7. **Authorization** - Enforce admin vs user access control

### Data Flow:
```
User → Login Form → Eka Backend → AccessHub API → Token + User Data
                                                  ↓
                                    Store Token (Cookie + DB)
                                                  ↓
                                    Save User Profile (DB)
                                                  ↓
                                    Redirect to Dashboard

Subsequent Requests:
User → Request → Eka Backend → Validate Token (Local) → Allow Access
                                    ↓ (expired)
                              Redirect to Login
```

---

**Document Version:** 1.0
**Last Updated:** 2026-05-12
**Status:** Ready for Implementation
