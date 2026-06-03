# AccessHub API Documentation

## Application User Provisioning API

### Overview
This API endpoint allows target applications to retrieve a list of all active users assigned to them along with their roles and profile details. This is designed for auto-provisioning purposes.

---

### Endpoint
```
GET /api/app_users.php
```

### Authentication
Requires an API token generated from the AccessHub settings page. The token must be associated with the requesting application and have at least `read` permission.

---

### Request Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `token` | string | Yes | API token generated from AccessHub |
| `app_name` | string | Yes | Name of the application (case-insensitive) |

---

### Example Request

```bash
curl -X GET "http://localhost:8000/src/api/app_users.php?token=abc123def456&app_name=CIS"
```

```javascript
// JavaScript/Node.js example
const response = await fetch(
  'http://localhost:8000/src/api/app_users.php?token=abc123def456&app_name=CIS'
);
const data = await response.json();
```

```python
# Python example
import requests

response = requests.get(
    'http://localhost:8000/src/api/app_users.php',
    params={
        'token': 'abc123def456',
        'app_name': 'CIS'
    }
)
data = response.json()
```

---

### Response Format

#### Success Response (200 OK)

```json
{
  "success": true,
  "application": "CIS",
  "timestamp": "2026-03-17T21:30:00+00:00",
  "user_count": 2,
  "users": [
    {
      "user_id": 1,
      "employee_id": "EMP001",
      "first_name": "John",
      "last_name": "Doe",
      "display_name": "John Doe",
      "email": "john.doe@example.com",
      "designation": "Software Engineer",
      "department": "Engineering",
      "location": "New York",
      "status": "Active",
      "experience": 5,
      "created_at": "2025-01-15 10:30:00",
      "reporting_manager": {
        "user_id": 2,
        "employee_id": "EMP002",
        "name": "Jane Smith",
        "email": "jane.smith@example.com",
        "designation": "Engineering Manager"
      },
      "business_roles": [
        {
          "business_role_name": "Software Developer",
          "business_role_description": "Standard developer role with code access"
        }
      ],
      "application_roles": [
        {
          "role_name": "Developer",
          "role_description": "Can create and edit code",
          "app_role_id": "AR00001",
          "assignment_type": "Business Role",
          "business_role_name": "Software Developer"
        },
        {
          "role_name": "Viewer",
          "role_description": "Read-only access",
          "app_role_id": "AR00002",
          "assignment_type": "Manual Assignment",
          "business_role_name": null
        }
      ]
    },
    {
      "user_id": 2,
      "employee_id": "EMP003",
      "first_name": "Alice",
      "last_name": "Johnson",
      "display_name": "Alice Johnson",
      "email": "alice.johnson@example.com",
      "designation": "Project Manager",
      "department": "Engineering",
      "location": "San Francisco",
      "status": "Active",
      "experience": 8,
      "created_at": "2024-06-20 14:45:00",
      "reporting_manager": {
        "user_id": 4,
        "employee_id": "EMP004",
        "name": "Bob Williams",
        "email": "bob.williams@example.com",
        "designation": "Director of Engineering"
      },
      "business_roles": [
        {
          "business_role_name": "Project Manager",
          "business_role_description": "Manages project timelines and resources"
        }
      ],
      "application_roles": [
        {
          "role_name": "Admin",
          "role_description": "Full administrative access",
          "app_role_id": "AR00003",
          "assignment_type": "Business Role",
          "business_role_name": "Project Manager"
        }
      ]
    }
  ]
}
```

---

### Error Responses

#### 400 Bad Request - Missing Parameters
```json
{
  "error": "Missing required parameters: token and app_name"
}
```

#### 403 Forbidden - Invalid Token
```json
{
  "error": "Invalid API token"
}
```

#### 403 Forbidden - Wrong Application
```json
{
  "error": "Token does not belong to the requested application"
}
```

#### 403 Forbidden - Insufficient Permission
```json
{
  "error": "Insufficient permission. Token must have read or both permissions."
}
```

#### 405 Method Not Allowed
```json
{
  "error": "Method not allowed. Only GET is supported."
}
```

#### 500 Internal Server Error
```json
{
  "error": "Internal server error"
}
```

---

### Response Fields Description

#### Root Level
- `success` (boolean): Indicates if the request was successful
- `application` (string): Name of the application
- `timestamp` (string): ISO 8601 timestamp of the response
- `user_count` (integer): Number of users returned
- `users` (array): Array of user objects

#### User Object
- `user_id` (integer): Internal user ID in AccessHub
- `employee_id` (string): Employee identifier
- `first_name` (string): User's first name
- `last_name` (string): User's last name
- `display_name` (string): User's full display name
- `email` (string): User's email address
- `designation` (string): Job title/designation
- `department` (string): Department name
- `location` (string): Office location
- `status` (string): User status (only "Active" users are returned)
- `experience` (integer): Years of experience
- `created_at` (string): Timestamp when user was created in AccessHub
- `reporting_manager` (object): Manager details
  - `user_id` (integer|null): Manager's internal user ID
  - `employee_id` (string|null): Manager's employee ID
  - `name` (string|null): Manager's display name
  - `email` (string|null): Manager's email
  - `designation` (string|null): Manager's job title
- `business_roles` (array): Array of organizational business roles
  - `business_role_name` (string): Name of the business role
  - `business_role_description` (string): Description of the business role
- `application_roles` (array): Array of application-specific role assignments

#### Role Object
- `role_name` (string): Name of the application role
- `role_description` (string): Description of the role
- `app_role_id` (string): Unique role identifier
- `assignment_type` (string): How the role was assigned
  - "Business Role": Assigned via business role mapping
  - "Manual Assignment": Manually assigned by admin
- `business_role_name` (string|null): Name of the business role (if applicable)

---

### Usage Notes

1. **Only Active Users**: The API only returns users with status "Active"
2. **Complete Profile**: All user profile fields from AccessHub are returned including creation date
3. **Two Types of Roles**:
   - **Business Roles**: Organizational roles (e.g., "Software Developer", "Project Manager") that grant access to multiple applications
   - **Application Roles**: Application-specific roles (e.g., "Admin", "Developer", "Viewer") that define what the user can do in your application
4. **Role Assignment Types**: Application roles show how they were assigned:
   - "Business Role": Inherited from business role mapping
   - "Manual Assignment": Directly assigned by admin
5. **Manager Information**: Complete reporting manager details including ID, email, and designation
6. **Ordering**: Users are returned sorted by display name

---

### How to Generate an API Token

1. Log in to AccessHub as an administrator
2. Navigate to **Settings** → **API Settings**
3. Select the application you want to generate a token for
4. Choose the permission level:
   - **Read**: Can only fetch data (sufficient for this endpoint)
   - **Write**: Can modify data
   - **Both**: Can read and write
5. Click **Generate Token**
6. Copy and securely store the generated token

**Security Note**: Treat API tokens like passwords. Store them securely and never commit them to version control.

---

### Integration Examples

#### Auto-Provisioning Script (PHP)

```php
<?php
function syncUsersFromAccessHub($apiToken, $appName, $accessHubUrl) {
    $url = $accessHubUrl . '/src/api/app_users.php?' . http_build_query([
        'token' => $apiToken,
        'app_name' => $appName
    ]);

    $response = file_get_contents($url);
    $data = json_decode($response, true);

    if (!$data['success']) {
        throw new Exception('Failed to fetch users from AccessHub');
    }

    foreach ($data['users'] as $user) {
        // Create or update user in your application
        createOrUpdateUser([
            'email' => $user['email'],
            'name' => $user['display_name'],
            'employee_id' => $user['employee_id'],
            'roles' => array_column($user['roles'], 'role_name')
        ]);
    }

    return $data['user_count'];
}
```

#### Auto-Provisioning with Cron Job

```bash
# Add to crontab to sync users every hour
0 * * * * /usr/bin/php /path/to/your/app/sync_users.php >> /var/log/user_sync.log 2>&1
```

---

### Rate Limiting

Currently, there are no rate limits on this API endpoint. However, it's recommended to:
- Cache results when possible
- Run provisioning scripts during off-peak hours
- Implement exponential backoff for retries

---

### Support

For issues or questions:
- Check the application logs at `AccessHub/log/php.log`
- Verify your API token is valid and has correct permissions
- Ensure your application name matches exactly (case-insensitive)

---

## Additional API Endpoints

### User Management API
- **Endpoint**: `/api/users.php`
- **Purpose**: Create, read, and update user records
- **Documentation**: See existing API implementation

### Notifications API
- **Endpoint**: `/api/notifications.php`
- **Purpose**: Fetch user notifications
- **Documentation**: See existing API implementation

---

*Last Updated: March 17, 2026*
