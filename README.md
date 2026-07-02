# Anand Jewellers

A professional jewelry storefront and admin management system for showcasing and selling gold, silver, and exquisite jewelry products.

## Project Overview

Anand Jewellers is a comprehensive web application designed for a jewelry business. It provides a high-end shopping experience for customers to explore jewelry collections and a powerful administrative dashboard for the business owner to manage inventory, update metal rates, and handle customer enquiries.

## Features

### 🛍️ Customer Experience

- **Product Catalog**: A visually appealing gallery of gold and silver jewelry.
- **Advanced Filtering**: Search and filter products by category and attributes for easy discovery.
- **Live Metal Rates**: Real-time display of current gold and silver prices.
- **About & Story**: Dedicated sections highlighting the shop's craftsmanship, values, and history.
- **Contact Integration**: Seamless communication through a dedicated contact page.

### 🛠️ Admin Dashboard

- **Inventory Management**: Full CRUD capabilities to add, edit, and remove jewelry products.
- **Rate Control**: Ability to update gold and silver rates instantly across the site.
- **Enquiry Management**: A centralized system to track and manage customer enquiries.
- **User Management**: Secure admin authentication and management of administrative accounts.
- **System Settings**: Configuration options for site-wide settings and security.

## Tech Stack

- **Frontend**: React 19, TypeScript, Vite
- **Styling**: Material UI (MUI), Tailwind CSS, Styled Components
- **Backend**: Supabase (PostgreSQL, Authentication, Storage)
- **Routing**: React Router DOM
- **Animations/Sliders**: Swiper.js

## Installation & Setup

1. **Clone the repository**:

   ```bash
   git clone https://github.com/Ads4331X/Jwelery
   cd gold
   ```

2. **Install dependencies**:

   ```bash
   npm install
   ```

3. **Environment Configuration**:
   Create a `.env` file in the root directory and add your Supabase credentials:

   ```env
   VITE_SUPABASE_URL=your_supabase_url
   VITE_SUPABASE_PUBLISHABLE_KEY=your_supabase_anon_key
   ```

4. **Run the development server**:
   ```bash
   npm run dev
   ```

## Project Structure

```text
src/
├── components/     # Shared UI components (Layout, UI, Shared)
├── features/       # Feature-based modules
│   ├── admin/      # Admin dashboard and management tools
│   ├── auth/       # Authentication logic and providers
│   ├── home/       # Landing page components
│   ├── products/   # Product listing and filtering
│   ├── about/      # About Us page
│   └── contact/    # Contact page
├── services/       # API services and Supabase configuration
└── styles/         # Global styles and CSS
```

## Usage

- **Customers**: Visit the home page to browse products and check current metal rates.
- **Admins**: Access the `/admin` route to manage the store's backend operations.

## License

This project is proprietary. All rights reserved.
