# MailPilot Enterprise — Setup & Deployment Guide

This guide provides step-by-step instructions for setting up, developing, and deploying the MailPilot Enterprise application.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Local Development Setup](#local-development-setup)
3. [Database Configuration](#database-configuration)
4. [Environment Variables](#environment-variables)
5. [Running the Application](#running-the-application)
6. [Deployment](#deployment)
7. [Troubleshooting](#troubleshooting)

## Prerequisites

### System Requirements
- **OS**: macOS, Linux, or Windows (with WSL2)
- **Node.js**: 20.0.0 or higher
- **pnpm**: 10.0.0 or higher
- **A Postgres database**: this project is set up to use [Neon](https://neon.tech) (serverless Postgres, no local install needed); any Postgres 12+ connection string works the same way
- **Git**: For version control

### Install Node.js and pnpm

**macOS (using Homebrew)**
```bash
brew install node@20
brew install pnpm
```

**Ubuntu/Debian**
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
npm install -g pnpm
```

**Windows (using Chocolatey)**
```bash
choco install nodejs pnpm
```

**Verify Installation**
```bash
node --version    # Should be v20.0.0 or higher
pnpm --version    # Should be 10.0.0 or higher
```

## Local Development Setup

### Step 1: Clone/Extract the Project

```bash
# Extract the project
unzip mailpilot-enterprise.zip
cd mailpilot-enterprise

# Or clone from Git
git clone https://github.com/your-org/mailpilot-enterprise.git
cd mailpilot-enterprise
```

### Step 2: Install Dependencies

```bash
# Install all dependencies for all workspaces
pnpm install

# This installs dependencies for:
# - backend/
# - admin-dashboard/
# - employee-app/
```

### Step 3: Set Up the Database (Neon)

1. Create a free project at [neon.tech](https://neon.tech).
2. From the Neon dashboard, copy the **pooled** connection string — it looks
   like:
   ```
   postgresql://<user>:<password>@<host>/<database>?sslmode=require
   ```
3. That's it — no local Postgres install, no Docker container. You'll drop
   this string into `backend/.env` as `DATABASE_URL` in the next step, and
   Prisma (via `pnpm db:push`) will create all the tables directly on Neon.

If you'd rather use a different Postgres provider or a local install, any
standard `postgresql://` connection string works the same way — Neon isn't
required by the code, it's just the recommended default.

### Step 4: Configure Environment Variables

**Backend (.env)**

```bash
cd backend
cp .env.example .env
nano .env
```

**Backend .env template:**
```env
# Database (Neon connection string — see Step 3)
DATABASE_URL=postgresql://<user>:<password>@<host>/<database>?sslmode=require

# JWT
JWT_SECRET=your-super-secret-key-min-32-chars-generated-with-openssl

# Gmail OAuth (get from Google Cloud Console)
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret

# Email Service (optional, for notifications)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASSWORD=your-app-password

# Node Environment
NODE_ENV=development
PORT=3000
```

**Admin Dashboard (.env)**

```bash
cd ../admin-dashboard
cp .env.example .env
nano .env
```

**Admin Dashboard .env template:**
```env
NEXT_PUBLIC_API_URL=http://localhost:3000
NEXT_PUBLIC_APP_NAME=MailPilot Admin
```

**Employee App (.env)**

```bash
cd ../employee-app
cp .env.example .env
nano .env
```

**Employee App .env template:**
```env
VITE_API_URL=http://localhost:3000
VITE_APP_TITLE=MailPilot
```

### Step 5: Run Database Migrations

```bash
# From project root
pnpm db:push

# Or manually
cd backend
pnpm prisma:migrate
```

### Step 6: Seed Database (Optional)

```bash
# Seed with demo data
pnpm db:seed
```

### Step 7: Start Development Servers

**Start All Services**

```bash
# From project root
pnpm dev
```

**Or Start Individual Services**

```bash
# Terminal 1: Backend
pnpm -C backend dev

# Terminal 2: Admin Dashboard
pnpm -C admin-dashboard dev

# Terminal 3: Employee App
pnpm -C employee-app dev
```

### Step 8: Access Applications

- **Backend API**: http://localhost:3000
- **Admin Dashboard**: http://localhost:3001
- **Employee App**: http://localhost:3002

## Database Configuration

### Connection String Format

```
postgresql://username:password@hostname:port/database
```

### PostgreSQL Connection Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `username` | postgres | Database user |
| `password` | - | User password |
| `hostname` | localhost | Database server |
| `port` | 5432 | PostgreSQL port |
| `database` | mailpilot | Database name |

### Database Backups

**Backup Database**

```bash
# Create backup
pg_dump -U mailpilot_user mailpilot > backup_$(date +%Y%m%d_%H%M%S).sql

# Compress backup
pg_dump -U mailpilot_user mailpilot | gzip > backup_$(date +%Y%m%d_%H%M%S).sql.gz
```

**Restore Database**

```bash
# Restore from backup
psql -U mailpilot_user mailpilot < backup_20260709_120000.sql

# Or from compressed backup
gunzip -c backup_20260709_120000.sql.gz | psql -U mailpilot_user mailpilot
```

## Environment Variables

### Backend Variables

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `DATABASE_URL` | Yes | PostgreSQL connection string | `postgresql://user:pass@localhost:5432/mailpilot` |
| `JWT_SECRET` | Yes | JWT signing secret (min 32 chars) | `your-super-secret-key-min-32-chars` |
| `GOOGLE_CLIENT_ID` | Yes | Gmail OAuth client ID | `123456.apps.googleusercontent.com` |
| `GOOGLE_CLIENT_SECRET` | Yes | Gmail OAuth client secret | `your-client-secret` |
| `SMTP_HOST` | No | Email service host | `smtp.gmail.com` |
| `SMTP_PORT` | No | Email service port | `587` |
| `SMTP_USER` | No | Email service user | `your-email@gmail.com` |
| `SMTP_PASSWORD` | No | Email service password | `your-app-password` |
| `NODE_ENV` | No | Environment | `development` or `production` |
| `PORT` | No | Server port | `3000` |

### Frontend Variables

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `VITE_API_URL` | Yes | Backend API URL | `http://localhost:3000` |
| `VITE_APP_TITLE` | No | Application title | `MailPilot` |

## Running the Application

### Development Mode

```bash
# Start all services with hot reload
pnpm dev

# Start individual service
pnpm -C backend dev
pnpm -C admin-dashboard dev
pnpm -C employee-app dev
```

### Production Mode

```bash
# Build all services
pnpm build

# Start production servers
pnpm start

# Or build and start individual services
pnpm -C backend build && pnpm -C backend start
```

### Running Tests

```bash
# Run all tests
pnpm test

# Run tests in watch mode
pnpm -C backend test --watch

# Run specific test file
pnpm -C backend test auth.test.ts

# Run with coverage
pnpm -C backend test --coverage
```

### Type Checking

```bash
# Check TypeScript types
pnpm check

# Or per service
pnpm -C backend check
pnpm -C employee-app check
```

### Code Formatting

```bash
# Format all code
pnpm format

# Or per service
pnpm -C backend format
pnpm -C employee-app format
```

## Deployment

### Production Build

```bash
# Build all services
pnpm build

# Output:
# - backend/dist/ - Compiled backend
# - admin-dashboard/.next/ - Built Next.js app
# - employee-app/dist/ - Built Vite app
```

### Deployment Platforms

#### Heroku

```bash
# Install Heroku CLI
npm install -g heroku

# Login to Heroku
heroku login

# Create app
heroku create mailpilot-enterprise

# Set environment variables
heroku config:set DATABASE_URL=postgresql://...
heroku config:set JWT_SECRET=...
heroku config:set GOOGLE_CLIENT_ID=...
heroku config:set GOOGLE_CLIENT_SECRET=...

# Deploy
git push heroku main
```

#### AWS (EC2 + RDS)

```bash
# 1. Create EC2 instance
# 2. Create RDS PostgreSQL database
# 3. SSH into EC2
ssh -i key.pem ec2-user@instance-ip

# 4. Clone repository
git clone https://github.com/your-org/mailpilot-enterprise.git
cd mailpilot-enterprise

# 5. Install Node.js and pnpm
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
npm install -g pnpm

# 6. Install dependencies
pnpm install

# 7. Configure environment
nano .env

# 8. Build and start
pnpm build
pnpm start
```

#### Google Cloud Run

```bash
# Build Docker image
docker build -t mailpilot-enterprise .

# Tag image
docker tag mailpilot-enterprise gcr.io/PROJECT_ID/mailpilot-enterprise

# Push to Google Container Registry
docker push gcr.io/PROJECT_ID/mailpilot-enterprise

# Deploy to Cloud Run
gcloud run deploy mailpilot-enterprise \
  --image gcr.io/PROJECT_ID/mailpilot-enterprise \
  --platform managed \
  --region us-central1 \
  --set-env-vars DATABASE_URL=postgresql://...
```

#### DigitalOcean App Platform

```bash
# 1. Connect GitHub repository
# 2. Create app from DigitalOcean dashboard
# 3. Configure build and run commands
# 4. Set environment variables
# 5. Deploy
```

### Reverse Proxy Setup (Nginx)

```bash
# Install Nginx
sudo apt-get install nginx

# Create Nginx config
sudo nano /etc/nginx/sites-available/mailpilot

# Configuration:
server {
    listen 80;
    server_name mailpilot.example.com;
    
    # Redirect HTTP to HTTPS
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name mailpilot.example.com;
    
    # SSL certificates
    ssl_certificate /etc/letsencrypt/live/mailpilot.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mailpilot.example.com/privkey.pem;
    
    # Security headers
    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    
    # Gzip compression
    gzip on;
    gzip_types text/plain text/css application/json application/javascript;
    
    # Proxy to Node.js
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

# Enable site
sudo ln -s /etc/nginx/sites-available/mailpilot /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

### SSL Certificate (Let's Encrypt)

```bash
# Install Certbot
sudo apt-get install certbot python3-certbot-nginx

# Generate certificate
sudo certbot certonly --nginx -d mailpilot.example.com

# Auto-renewal
sudo systemctl enable certbot.timer
```

## Troubleshooting

### Database Connection Issues

**Error**: `connect ECONNREFUSED 127.0.0.1:5432`

```bash
# Check PostgreSQL is running
sudo systemctl status postgresql

# Start PostgreSQL
sudo systemctl start postgresql

# Check connection string
echo $DATABASE_URL
```

**Error**: `Access denied for user`

```bash
# Verify credentials
psql -U mailpilot_user -h localhost mailpilot

# Reset password
sudo -u postgres psql
ALTER USER mailpilot_user WITH PASSWORD 'new_password';
\q
```

### Port Already in Use

```bash
# Find process using port
lsof -i :3000

# Kill process
kill -9 <PID>

# Or use different port
PORT=3001 pnpm -C backend dev
```

### Dependencies Issues

```bash
# Clear cache and reinstall
pnpm clean
rm -rf node_modules
pnpm install
```

### Build Errors

```bash
# Clear build artifacts
pnpm -r clean

# Rebuild
pnpm build

# Check for TypeScript errors
pnpm check
```

### Environment Variables Not Loaded

```bash
# Verify .env file exists
ls -la backend/.env

# Check environment variables are set
env | grep DATABASE_URL

# Reload shell
source ~/.bashrc
```

## Performance Optimization

### Database
- Enable query logging to identify slow queries
- Create indexes for frequently queried columns
- Use connection pooling

### Application
- Enable gzip compression
- Use CDN for static assets
- Implement caching strategies
- Monitor API response times

### Monitoring
```bash
# Monitor process
top -p $(pgrep -f "node dist/index.js")

# Check memory usage
free -h

# Check disk usage
df -h
```

## Security Checklist

- ✅ Change default passwords
- ✅ Set strong JWT_SECRET
- ✅ Enable HTTPS/SSL
- ✅ Configure CORS properly
- ✅ Set up rate limiting
- ✅ Enable database backups
- ✅ Monitor access logs
- ✅ Keep dependencies updated
- ✅ Use environment variables for secrets
- ✅ Enable database encryption

## Support

For issues and questions:
- Check the README.md for general information
- Review MIGRATION_NOTES.md for merge details
- Check individual service documentation
- Submit issues on GitHub
- Contact support@mailpilot.com

## Next Steps

1. Complete the setup following this guide
2. Run the application in development mode
3. Test all features
4. Configure for your environment
5. Deploy to production

---

**Last Updated**: July 2026
**Version**: 1.0.0
