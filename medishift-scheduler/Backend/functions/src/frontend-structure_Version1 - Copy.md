frontend/
├── public/
│   ├── index.html
│   ├── favicon.ico
│   └── manifest.json
├── src/
│   ├── components/
│   │   ├── Auth/
│   │   │   ├── LoginForm.tsx
│   │   │   ├── PrivateRoute.tsx
│   │   │   └── RoleGuard.tsx
│   │   ├── Layout/
│   │   │   ├── Layout.tsx
│   │   │   ├── Header.tsx
│   │   │   ├── Sidebar.tsx
│   │   │   └── Footer.tsx
│   │   ├── Schedule/
│   │   │   ├── CalendarView.tsx
│   │   │   ├── ScheduleCard.tsx
│   │   │   └── ConflictIndicator.tsx
│   │   └── Common/
│   │       ├── Button.tsx
│   │       ├── Modal.tsx
│   │       ├── Loading.tsx
│   │       └── ErrorBoundary.tsx
│   ├── contexts/
│   │   ├── AuthContext.tsx
│   │   ├── ThemeContext.tsx
│   │   └── NotificationContext.tsx
│   ├── hooks/
│   │   ├── useAuth.ts
│   │   ├── useFirestore.ts
│   │   ├── useSchedule.ts
│   │   └── useNotifications.ts
│   ├── pages/
│   │   ├── Auth/
│   │   ├── Dashboard/
│   │   ├── Schedule/
│   │   ├── Leave/
│   │   ├── Education/
│   │   ├── Reports/
│   │   └── Settings/
│   ├── services/
│   │   ├── api.ts
│   │   ├── auth.service.ts
│   │   ├── schedule.service.ts
│   │   └── leave.service.ts
│   ├── styles/
│   │   ├── globals.css
│   │   └── tailwind.css
│   ├── types/
│   │   └── index.ts (import from shared)
│   ├── utils/
│   │   ├── constants.ts
│   │   ├── helpers.ts
│   │   └── validators.ts
│   ├── App.tsx
│   ├── index.tsx
│   └── firebase-config.ts
├── .env.example
├── .gitignore
├── package.json
├── tsconfig.json
└── tailwind.config.js