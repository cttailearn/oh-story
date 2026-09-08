import React from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import './styles/tokens.css';
import './styles/layout.css';
import { AppShell } from './App.tsx';
import { BookShelfPage } from './pages/BookShelfPage.tsx';
import { NewProjectPage } from './pages/NewProjectPage.tsx';
import { NovelWorkspacePage } from './pages/NovelWorkspacePage.tsx';
import { PipelinePage } from './pages/PipelinePage.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';
import { ModulesPage } from './pages/ModulesPage.tsx';
import { TeardownPage } from './pages/TeardownPage.tsx';
import { ExportPage } from './pages/ExportPage.tsx';
import { NewNovelPage } from './pages/NewNovelPage.tsx';
import { ImportReviewPage } from './pages/ImportReviewPage.tsx';

const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <BookShelfPage /> },
      { path: 'projects/new', element: <NewProjectPage /> },
      { path: 'projects/:projectId', element: <BookShelfPage inside /> },
      { path: 'novels/new', element: <NewNovelPage /> },
      { path: 'novels/:bookId', element: <NovelWorkspacePage /> },
      { path: 'novels/:bookId/import-review', element: <ImportReviewPage /> },
      { path: 'novels/:bookId/pipeline', element: <PipelinePage /> },
      { path: 'modules', element: <ModulesPage /> },
      { path: 'teardowns/:bookId', element: <TeardownPage /> },
      { path: 'export', element: <ExportPage /> },
      { path: 'settings', element: <SettingsPage /> },
    ],
  },
]);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
