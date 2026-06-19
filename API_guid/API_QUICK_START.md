# AccessHub API - Quick Start Guide

## Application User Provisioning API

### What It Does
Allows target applications to pull a list of all active users assigned to them along with their roles and profile details for auto-provisioning.

---

## Setup

### 1. Generate an API Token

1. Log in to AccessHub as an admin
2. Go to **Settings** → **API Settings** tab
3. Select your application from the dropdown
4. Choose permission: **Read** (or **Both**)
5. Click **Generate Token**
6. **Copy and save the token securely** - you won't see it again!

Example token: `229910424390b84cecfb33f37f1d4e94`

---

## Usage

### API Endpoint
```
GET /src/api/app_users.php?token={YOUR_TOKEN}&app_name={YOUR_APP_NAME}
```

### Example Request (curl)
```bash
curl -X GET "http://localhost:8000/src/api/app_users.php?token=229910424390b84cecfb33f37f1d4e94&app_name=CIS"
```

### Example Response
```json
{
  "success": true,
  "application": "CIS",
  "timestamp": "2026-03-17T21:30:00+00:00",
  "user_count": 5,
  "users": [
    {
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
      "experience": 5,
      "created_at": "2025-01-15 10:30:00",
      "reporting_manager": {
        "user_id": 10,
        "employee_id": "1001",
        "name": "Manager Name",
        "email": "manager@example.com",
        "designation": "Engineering Manager"
      },
      "business_roles": [
        {
          "business_role_name": "Software Developer",
          "business_role_description": "Standard developer role"
        }
      ],
      "application_roles": [
        {
          "role_name": "CRMAdmin",
          "role_description": "CRM Administrator",
          "app_role_id": "AR00001",
          "assignment_type": "Business Role",
          "business_role_name": "Software Developer"
        }
      ]
    }
  ]
}
```

---

## Integration Examples

### PHP - Sync Users Daily
```php
<?php
// sync_users.php - Run this via cron job

$accessHubUrl = 'http://localhost:8000';
$apiToken = '229910424390b84cecfb33f37f1d4e94';
$appName = 'CIS';

$url = $accessHubUrl . '/src/api/app_users.php?' . http_build_query([
    'token' => $apiToken,
    'app_name' => $appName
]);

$response = file_get_contents($url);
$data = json_decode($response, true);

if ($data['success']) {
    foreach ($data['users'] as $user) {
        // Your provisioning logic here
        echo "Syncing user: {$user['email']}\n";

        // Example: Create or update user in your application
        $appRoles = array_column($user['application_roles'], 'role_name');
        $businessRoles = array_column($user['business_roles'], 'business_role_name');

        createOrUpdateUser([
            'email' => $user['email'],
            'name' => $user['display_name'],
            'employee_id' => $user['employee_id'],
            'department' => $user['department'],
            'designation' => $user['designation'],
            'manager_email' => $user['reporting_manager']['email'],
            'application_roles' => $appRoles,
            'business_roles' => $businessRoles
        ]);
    }
    echo "Synced {$data['user_count']} users\n";
} else {
    echo "Error: Failed to fetch users\n";
}
```

### Cron Job Setup
```bash
# Run sync every day at 2 AM
0 2 * * * /usr/bin/php /path/to/your/app/sync_users.php >> /var/log/user_sync.log 2>&1
```

### Python Example
```python
import requests

# Configuration
ACCESS_HUB_URL = 'http://localhost:8000'
API_TOKEN = '229910424390b84cecfb33f37f1d4e94'
APP_NAME = 'CIS'

# Make API request
response = requests.get(
    f'{ACCESS_HUB_URL}/src/api/app_users.php',
    params={'token': API_TOKEN, 'app_name': APP_NAME}
)

data = response.json()

if data['success']:
    print(f"Found {data['user_count']} users")
    for user in data['users']:
        print(f"- {user['display_name']} ({user['email']})")
        app_roles = [role['role_name'] for role in user['application_roles']]
        business_roles = [role['business_role_name'] for role in user['business_roles']]
        print(f"  Application Roles: {', '.join(app_roles)}")
        print(f"  Business Roles: {', '.join(business_roles)}")
        # Your provisioning logic here
else:
    print(f"Error: {data.get('error')}")
```

### JavaScript/Node.js Example
```javascript
const axios = require('axios');

const ACCESS_HUB_URL = 'http://localhost:8000';
const API_TOKEN = '229910424390b84cecfb33f37f1d4e94';
const APP_NAME = 'CIS';

async function syncUsers() {
  try {
    const response = await axios.get(`${ACCESS_HUB_URL}/src/api/app_users.php`, {
      params: {
        token: API_TOKEN,
        app_name: APP_NAME
      }
    });

    const data = response.data;

    if (data.success) {
      console.log(`Found ${data.user_count} users`);

      for (const user of data.users) {
        console.log(`Syncing: ${user.email}`);
        const appRoles = user.application_roles.map(r => r.role_name);
        const businessRoles = user.business_roles.map(r => r.business_role_name);

        // Your provisioning logic here
        await createOrUpdateUser({
          email: user.email,
          name: user.display_name,
          employeeId: user.employee_id,
          department: user.department,
          applicationRoles: appRoles,
          businessRoles: businessRoles
        });
      }
    }
  } catch (error) {
    console.error('Error fetching users:', error.message);
  }
}

syncUsers();
```

---

## What You Get

For each user, you'll receive:

### User Profile (Complete)
- User ID (internal)
- Employee ID
- Full name (first, last, display)
- Email address
- Designation (job title)
- Department
- Location/Office
- Status (only Active users returned)
- Experience (years as integer)
- Created date (when added to AccessHub)

### Reporting Manager (Complete Details)
- Manager's user ID
- Manager's employee ID
- Manager's full name
- Manager's email
- Manager's designation

### Business Roles (Organizational)
- Business role name
- Business role description
- These are organization-wide roles like "Software Developer", "Manager", etc.

### Application Roles (App-Specific)
- Role name in your application
- Role description
- Unique role ID
- Assignment type (Business Role or Manual Assignment)
- Source business role name (if inherited from business role)

---

## Important Notes

1. **Only Active Users**: API returns only users with status "Active"
2. **Security**: Store API tokens securely, never commit to version control
3. **Rate Limiting**: No current limits, but cache results when possible
4. **Deduplication**: Users with multiple role assignments will show each role separately

---

## Troubleshooting

### Error: "Invalid API token"
- Check that your token is correct
- Verify token hasn't been deleted from Settings

### Error: "Token does not belong to the requested application"
- Ensure app_name matches exactly
- Token must be generated for the specific application

### Error: "Insufficient permission"
- Token needs at least "read" permission
- Regenerate token with correct permissions

### No users returned
- Check if users are assigned to your application in AccessHub
- Verify users have "Active" status
- Check application roles are defined

---

## Testing

You can test the API directly in your browser or using curl:

```bash
# Replace with your token and app name
curl "http://localhost:8000/src/api/app_users.php?token=YOUR_TOKEN&app_name=YOUR_APP"
```

---

## Need Help?

- Full documentation: See `API_DOCUMENTATION.md`
- Check logs: `AccessHub/log/php.log`
- Verify database: Check `user_applications` and `user_manual_applications` tables

---

*Last Updated: March 17, 2026*
