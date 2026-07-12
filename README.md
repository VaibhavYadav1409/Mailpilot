# MailPilot Enterprise — Unified Email Management Platform

A comprehensive, enterprise-grade email management system combining a robust backend infrastructure with a modern, feature-rich employee application and administrative dashboard.

## Overview

MailPilot Enterprise is a monorepo project consisting of three main components:

- **Backend**: Express.js server with Prisma ORM, providing RESTful APIs for email management, analytics, and authentication
- **Admin Dashboard**: Next.js application for administrative oversight, employee management, and analytics
- **Employee App**: Modern React application with AI-powered email insights, powered by Project 2's superior UI/UX

## Project Structure

```
mailpilot-enterprise/
├── backend/                 # Express + Prisma + PostgreSQL backend
│   ├── src/
│   │   ├── routes/         # API endpoints (auth, emails, analytics, etc.)
│   │   ├── services/       # Business logic (Gmail sync, AI pipeline, etc.)
│   │   ├── middleware/     # Auth, RBAC middleware
│   │   ├── lib/            # Utilities (crypto, db, JWT, LLM)
│   │   └── server.ts       # Express app entry point
│   ├── prisma/
│   │   └── schema.prisma   # Database schema
│   └── package.json
│
├── admin-dashboard/         # Next.js admin interface
│   ├── src/
│   │   ├── app/            # Next.js app directory
│   │   ├── components/     # React components
│   │   ├── services/       # API integration
│   │   └── store/          # State management
│   └── package.json
│
├── employee-app/            # Modern React employee application (Project 2)
│   ├── src/
│   │   ├── components/     # UI components (shadcn/ui based)
│   │   ├── pages/          # Page components
│   │   ├── hooks/          # Custom React hooks
│   │   ├── lib/            # Utilities and API client
│   │   ├── contexts/       # React contexts (theme, etc.)
│   │   └── main.tsx        # React entry point
│   ├── index.html
│   └── package.json
│
├── shared/                  # Shared types and constants
│   ├── types.ts            # TypeScript type definitions
│   ├── const.ts            # Shared constants
│   └── _core/errors.ts     # Error definitions
│
├── pnpm-workspace.yaml      # pnpm workspace configuration
└── package.json             # Root package.json

```

## Features

### Employee Application
- **Modern UI**: Clean, responsive interface built with React 19 and Tailwind CSS
- **Email Management**: Inbox, Sent, Drafts, Archived, Spam, Trash folders
- **Advanced Filtering**: Filter by read/unread, replied/unreplied, sent, promotions
- **AI-Powered Insights**: 
  - Email summaries
  - Priority scoring (1-10)
  - Suggested replies
  - Draft generation
- **Gmail Integration**: Connect Gmail accounts for seamless email sync
- **IMAP Support**: Connect any email provider via IMAP
- **Rich Email Viewer**: Display emails with attachments, threading, and formatting
- **Reply Composer**: Compose and send replies with attachment support
- **Settings**: Configure Gmail/IMAP credentials and AI settings
- **Theme Support**: Light/dark mode toggle
- **Responsive Design**: Works on desktop and mobile devices

### Admin Dashboard
- **Employee Management**: View and manage employees
- **Department Management**: Organize employees by departments
- **Analytics**: Track email activity, response times, and engagement
- **Reports**: Generate detailed reports on employee activity
- **Leaderboards**: Performance metrics and rankings
- **Settings**: Configure system-wide settings
- **Live Updates**: Real-time dashboard updates via WebSocket

### Backend
- **Authentication**: JWT-based authentication with refresh tokens
- **RBAC**: Role-based access control (CEO, Manager, Employee)
- **Gmail Sync**: Automatic Gmail account connection and email synchronization
- **AI Pipeline**: Email analysis with summary, priority, and reply suggestions
- **Analytics Engine**: Real-time and scheduled analytics computation
- **Email Management**: Full email lifecycle management (read, star, trash, etc.)
- **Notification System**: Real-time notifications for important events
- **Report Generation**: Scheduled and on-demand report generation
- **WebSocket Support**: Live updates for admin dashboard

## Tech Stack

### Frontend (Employee App)
- **Framework**: React 19
- **Language**: TypeScript
- **Styling**: Tailwind CSS 4
- **UI Components**: shadcn/ui
- **State Management**: React Hooks, React Query
- **Routing**: Wouter
- **Forms**: React Hook Form
- **Notifications**: Sonner
- **Icons**: Lucide React

### Frontend (Admin Dashboard)
- **Framework**: Next.js
- **Language**: TypeScript
- **Styling**: Tailwind CSS
- **UI Components**: Custom components
- **State Management**: Zustand (store)

### Backend
- **Runtime**: Node.js 20+
- **Framework**: Express.js
- **Language**: TypeScript
- **Database**: PostgreSQL with Prisma ORM
- **Real-time**: Socket.IO
- **Authentication**: JWT with bcrypt
- **Email**: Nodemailer
- **Scheduling**: node-cron
- **Rate Limiting**: express-rate-limit
- **Security**: Helmet

## Installation

### Prerequisites
- Node.js 20.0.0 or higher
- pnpm 10.0.0 or higher
- A PostgreSQL database — this project is set up to use [Neon](https://neon.tech) (serverless Postgres); any Postgres 12+ connection string works the same way

### Setup

1. **Clone and Install Dependencies**
   ```bash
   cd mailpilot-enterprise
   pnpm install
   ```

2. **Configure Environment Variables**
   ```bash
   # Backend
   cp backend/.env.example backend/.env
   
   # Admin Dashboard
   cp admin-dashboard/.env.example admin-dashboard/.env
   
   # Employee App
   cp employee-app/.env.example employee-app/.env
   ```

3. **Set Up Database**
   ```bash
   # Generate and apply migrations
   pnpm db:push
   
   # Seed with demo data (optional)
   pnpm db:seed
   ```

4. **Start Development Servers**
   ```bash
   # Start all services
   pnpm dev
   
   # Or start individual services
   pnpm -C backend dev
   pnpm -C admin-dashboard dev
   pnpm -C employee-app dev
   ```

5. **Access Applications**
   - Backend API: http://localhost:3000
   - Admin Dashboard: http://localhost:3001
   - Employee App: http://localhost:3002

## Database (Neon)

This project runs against a plain Postgres connection string, so it works
as-is with [Neon](https://neon.tech):

1. Create a Neon project and copy the connection string it gives you
   (use the **pooled** connection string for the app itself).
2. Set it as `DATABASE_URL` in `backend/.env`, e.g.:
   ```
   DATABASE_URL="postgresql://<user>:<password>@<host>/<db>?sslmode=require"
   ```
3. Push the schema and generate the Prisma client:
   ```bash
   pnpm -C backend prisma:generate
   pnpm db:push
   ```
4. Optionally seed demo data:
   ```bash
   pnpm db:seed
   ```

No Docker or local Postgres install is required — every service (`backend`,
`admin-dashboard`, `employee-app`) runs directly with `pnpm dev` / `pnpm build`
/ `pnpm start` as shown above.

## Environment Variables

### Backend (.env)
```env
# Database
DATABASE_URL=postgresql://user:password@localhost:5432/mailpilot

# JWT
JWT_SECRET=your-super-secret-key-min-32-chars

# Gmail OAuth
GOOGLE_CLIENT_ID=your-client-id
GOOGLE_CLIENT_SECRET=your-client-secret

# Email Service
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASSWORD=your-app-password

# Analytics
ANALYTICS_ENABLED=true

# Node
NODE_ENV=development
PORT=3000
```

### Admin Dashboard (.env)
```env
NEXT_PUBLIC_API_URL=http://localhost:3000
NEXT_PUBLIC_APP_NAME=MailPilot Admin
```

### Employee App (.env)
```env
VITE_API_URL=http://localhost:3000
VITE_APP_TITLE=MailPilot
```

## API Documentation

### Authentication
- `POST /api/auth/login` - Login with email and password
- `POST /api/auth/logout` - Logout
- `GET /api/auth/me` - Get current user
- `POST /api/auth/refresh` - Refresh JWT token

### Emails
- `GET /api/emails` - List emails (with pagination)
- `GET /api/emails/:id` - Get email details
- `POST /api/emails/sync` - Sync emails from Gmail
- `POST /api/emails/:id/reply` - Send reply
- `POST /api/emails/:id/summary` - Generate summary
- `POST /api/emails/:id/suggested-reply` - Generate suggested reply
- `PATCH /api/emails/:id` - Update email (mark read, star, trash, etc.)

### Gmail
- `GET /api/gmail/status` - Check Gmail connection status
- `POST /api/gmail/connect` - Initiate Gmail OAuth flow
- `POST /api/gmail/disconnect` - Disconnect Gmail account

### Analytics
- `GET /api/analytics/dashboard` - Get dashboard metrics
- `GET /api/analytics/reports` - Get analytics reports
- `GET /api/analytics/leaderboard` - Get employee leaderboard

## Development

### Running Tests
```bash
# Run all tests
pnpm test

# Run tests in watch mode
pnpm -C backend test --watch

# Run specific test file
pnpm -C backend test auth.test.ts
```

### Code Quality
```bash
# Type check
pnpm check

# Format code
pnpm format

# Lint (if configured)
pnpm lint
```

### Database Migrations
```bash
# Create new migration
pnpm -C backend prisma:migrate

# View migrations
pnpm -C backend prisma studio
```

## Deployment

### Production Build
```bash
# Build all services
pnpm build

# Start production servers
pnpm start
```

### Deployment Platforms
- **Heroku**: Configure environment variables and deploy
- **AWS**: Use EC2, RDS for database, and S3 for file storage
- **Google Cloud**: Use Cloud Run, Cloud SQL, and Cloud Storage
- **DigitalOcean**: Use App Platform and Managed Databases

## Architecture

The project follows a monorepo structure with clear separation of concerns:

1. **Backend**: Provides RESTful APIs and handles business logic
2. **Admin Dashboard**: Manages administrative tasks and analytics
3. **Employee App**: User-facing interface for email management
4. **Shared**: Common types and utilities

All components communicate through well-defined APIs and share common types defined in the `shared` directory.

## Security

- **Authentication**: JWT-based with refresh tokens
- **Authorization**: Role-based access control (RBAC)
- **Encryption**: Passwords hashed with bcrypt
- **CORS**: Configured for allowed origins
- **Rate Limiting**: API rate limiting to prevent abuse
- **Security Headers**: Helmet.js for HTTP security headers
- **Input Validation**: Zod for schema validation

## Performance

- **Database**: Indexed queries for fast data retrieval
- **Caching**: React Query for client-side caching
- **Pagination**: Cursor-based pagination for large datasets
- **Compression**: gzip compression for API responses
- **CDN**: Static assets served via CDN in production
- **Lazy Loading**: Code splitting and lazy loading for frontend

## Troubleshooting

### Database Connection Issues
```bash
# Check database connection
psql $DATABASE_URL

# Reset database
pnpm -C backend prisma:migrate reset
```

### Port Already in Use
```bash
# Find and kill process using port
lsof -i :3000
kill -9 <PID>
```

### Dependencies Issues
```bash
# Clear cache and reinstall
pnpm clean
pnpm install
```

## Contributing

1. Create a feature branch
2. Make your changes
3. Run tests: `pnpm test`
4. Submit a pull request

## License

MIT License - See LICENSE file for details

## Support

For issues and questions:
- GitHub Issues: [Project Issues](https://github.com/your-repo/issues)
- Documentation: [Full Docs](https://docs.example.com)
- Email: support@mailpilot.com

## Changelog

### Version 1.0.0 (July 2026)
- Initial release with merged employee application
- Modern UI from Project 2
- Enterprise backend from Project 1
- Admin dashboard
- AI-powered email insights
- Gmail and IMAP integration
- Comprehensive analytics
