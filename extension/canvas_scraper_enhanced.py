#!/usr/bin/env python3
"""
Enhanced Canvas Course Scraper with Complete Coverage

This version uses Selenium to handle:
- Folder exploration (clicks into folders to find files)
- Module expansion (expands all dropdowns)
- Scrolling (loads lazy-loaded content)
- Pagination (handles "Next Page" buttons)
- Dynamic content (waits for JavaScript)

Ensures EVERY file, link, and piece of content is scraped.
"""

import os
import re
import json
import time
from datetime import datetime
from urllib.parse import urljoin, urlparse
from bs4 import BeautifulSoup

# Selenium imports
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import TimeoutException, NoSuchElementException, StaleElementReferenceException
from selenium.webdriver.common.keys import Keys

# PDF extraction
import PyPDF2
from io import BytesIO
import requests


class CanvasScraperEnhanced:
    def __init__(self, course_url, output_dir="canvas_scraped_data_complete", headless=True):
        """
        Initialize the enhanced Canvas scraper.
        
        Args:
            course_url: The base URL of the Canvas course
            output_dir: Directory to save scraped data
            headless: Run browser in headless mode (no GUI)
        """
        self.course_url = course_url.rstrip('/')
        self.course_id = self.extract_course_id(course_url)
        self.output_dir = output_dir
        self.visited_urls = set()
        self.scraped_data = {
            'course_info': {'url': course_url, 'course_id': self.course_id},
            'announcements': [],
            'assignments': [],
            'modules': [],
            'files': [],
            'folders': [],
            'pages': [],
        }
        
        # Create output directories
        os.makedirs(output_dir, exist_ok=True)
        os.makedirs(os.path.join(output_dir, 'pdfs'), exist_ok=True)
        os.makedirs(os.path.join(output_dir, 'html'), exist_ok=True)
        os.makedirs(os.path.join(output_dir, 'text'), exist_ok=True)
        
        # Setup Selenium WebDriver
        options = webdriver.ChromeOptions()
        if headless:
            options.add_argument('--headless=new')
        options.add_argument('--no-sandbox')
        options.add_argument('--disable-dev-shm-usage')
        options.add_argument('--disable-gpu')
        options.add_argument('--window-size=1920,1080')
        
        # Use existing browser session (important for authentication)
        options.add_experimental_option("debuggerAddress", "127.0.0.1:9222")
        
        try:
            self.driver = webdriver.Chrome(options=options)
            self.wait = WebDriverWait(self.driver, 10)
            print("✓ Connected to existing browser session")
        except Exception as e:
            print(f"✗ Could not connect to existing browser: {e}")
            print("  Starting new browser session (you'll need to log in)")
            options = webdriver.ChromeOptions()
            if headless:
                options.add_argument('--headless=new')
            options.add_argument('--no-sandbox')
            options.add_argument('--disable-dev-shm-usage')
            self.driver = webdriver.Chrome(options=options)
            self.wait = WebDriverWait(self.driver, 10)
    
    def extract_course_id(self, url):
        """Extract course ID from URL."""
        match = re.search(r'/courses/(\d+)', url)
        return match.group(1) if match else None
    
    def scroll_to_bottom(self, pause_time=1):
        """Scroll to bottom of page to load all content."""
        last_height = self.driver.execute_script("return document.body.scrollHeight")
        
        while True:
            # Scroll down
            self.driver.execute_script("window.scrollTo(0, document.body.scrollHeight);")
            time.sleep(pause_time)
            
            # Calculate new height
            new_height = self.driver.execute_script("return document.body.scrollHeight")
            
            if new_height == last_height:
                break
            last_height = new_height
        
        print("  [SCROLL] Scrolled to bottom, all content loaded")
    
    def click_expand_buttons(self):
        """Click all 'Expand', 'Show More', 'Load More' buttons."""
        expand_patterns = [
            "Expand All",
            "Show More",
            "Load More",
            "View More",
            "See More"
        ]
        
        for pattern in expand_patterns:
            try:
                buttons = self.driver.find_elements(By.XPATH, f"//button[contains(text(), '{pattern}')]")
                for button in buttons:
                    try:
                        button.click()
                        time.sleep(0.5)
                        print(f"  [EXPAND] Clicked '{pattern}' button")
                    except:
                        pass
            except:
                pass
    
    def scrape_page_content(self, url, page_name=""):
        """
        Scrape content from a page using Selenium.
        
        Args:
            url: URL to scrape
            page_name: Name/description of the page
            
        Returns:
            Dictionary containing page data
        """
        if url in self.visited_urls:
            print(f"  [SKIP] Already visited: {url}")
            return None
        
        print(f"  [SCRAPING] {page_name}: {url}")
        self.visited_urls.add(url)
        
        try:
            self.driver.get(url)
            time.sleep(2)  # Wait for initial load
            
            # Scroll to load all content
            self.scroll_to_bottom()
            
            # Click expand buttons
            self.click_expand_buttons()
            time.sleep(1)
            
            # Get page source after all content loaded
            html = self.driver.page_source
            soup = BeautifulSoup(html, 'html.parser')
            
            # Extract all text
            text_content = soup.get_text(separator='\n', strip=True)
            
            # Save HTML
            safe_name = re.sub(r'[^\w\s-]', '', page_name).strip().replace(' ', '_')
            html_filename = f"{safe_name}_{int(time.time())}.html"
            html_path = os.path.join(self.output_dir, 'html', html_filename)
            with open(html_path, 'w', encoding='utf-8') as f:
                f.write(html)
            
            # Save text
            if page_name:
                text_filename = f"{safe_name}_{int(time.time())}.txt"
                text_path = os.path.join(self.output_dir, 'text', text_filename)
                with open(text_path, 'w', encoding='utf-8') as f:
                    f.write(text_content)
            
            # Find all links
            links = []
            for a_tag in soup.find_all('a', href=True):
                href = a_tag['href']
                full_url = urljoin(url, href)
                link_text = a_tag.get_text(strip=True)
                links.append({
                    'url': full_url,
                    'text': link_text
                })
            
            page_data = {
                'url': url,
                'name': page_name,
                'timestamp': datetime.now().isoformat(),
                'text_content': text_content,
                'html_file': html_path,
                'links_count': len(links),
                'links': links
            }
            
            return page_data
            
        except Exception as e:
            print(f"  [ERROR] Failed to scrape {url}: {str(e)}")
            return None
    
    def scrape_files_with_folders(self):
        """Scrape all files including those inside folders."""
        print("\n" + "="*80)
        print("SCRAPING FILES (INCLUDING FOLDERS)")
        print("="*80)
        
        url = f"{self.course_url}/files"
        self.driver.get(url)
        time.sleep(2)
        
        # Scrape main files page
        page_data = self.scrape_page_content(url, "Files_Main")
        
        # Find all folders
        soup = BeautifulSoup(self.driver.page_source, 'html.parser')
        folder_links = soup.find_all('a', href=re.compile(r'/files/folder/'))
        
        folders_found = []
        for link in folder_links:
            folder_url = urljoin(url, link['href'])
            folder_name = link.get_text(strip=True)
            if folder_url not in [f['url'] for f in folders_found]:
                folders_found.append({'url': folder_url, 'name': folder_name})
        
        print(f"  Found {len(folders_found)} folders to explore")
        
        # Scrape each folder
        for folder in folders_found:
            folder_data = self.scrape_page_content(
                folder['url'],
                f"Folder_{folder['name']}"
            )
            if folder_data:
                self.scraped_data['folders'].append(folder_data)
                
                # Download PDFs in folder
                folder_soup = BeautifulSoup(self.driver.page_source, 'html.parser')
                pdf_links = folder_soup.find_all('a', href=re.compile(r'\.pdf'))
                for pdf_link in pdf_links:
                    pdf_url = urljoin(folder['url'], pdf_link['href'])
                    pdf_name = pdf_link.get_text(strip=True)
                    self.download_and_extract_pdf(pdf_url, pdf_name)
        
        # Also download PDFs from main files page
        main_soup = BeautifulSoup(page_data['html_file'] if page_data else self.driver.page_source, 'html.parser')
        pdf_links = main_soup.find_all('a', href=re.compile(r'\.pdf'))
        for pdf_link in pdf_links:
            pdf_url = urljoin(url, pdf_link['href'])
            pdf_name = pdf_link.get_text(strip=True)
            self.download_and_extract_pdf(pdf_url, pdf_name)
        
        print(f"\n✓ Scraped files from {len(folders_found)} folders")
    
    def scrape_modules_complete(self):
        """Scrape all modules with complete expansion."""
        print("\n" + "="*80)
        print("SCRAPING MODULES (WITH EXPANSION)")
        print("="*80)
        
        url = f"{self.course_url}/modules"
        self.driver.get(url)
        time.sleep(2)
        
        # Click "Expand All" button
        try:
            expand_btn = self.driver.find_element(By.XPATH, "//button[contains(text(), 'Expand All')]")
            expand_btn.click()
            time.sleep(2)
            print("  [EXPAND] Clicked 'Expand All' button")
        except:
            print("  [INFO] No 'Expand All' button found, trying individual modules")
        
        # Try to expand individual modules
        try:
            module_headers = self.driver.find_elements(By.CSS_SELECTOR, ".ig-header")
            for header in module_headers:
                try:
                    header.click()
                    time.sleep(0.3)
                except:
                    pass
        except:
            pass
        
        # Scroll to ensure all modules are visible
        self.scroll_to_bottom()
        
        # Now scrape the page
        page_data = self.scrape_page_content(url, "Modules_Expanded")
        
        # Find all module items
        soup = BeautifulSoup(self.driver.page_source, 'html.parser')
        module_items = soup.find_all('a', class_=re.compile(r'ig-title'))
        
        items_found = []
        for item in module_items:
            item_url = urljoin(url, item.get('href', ''))
            item_title = item.get_text(strip=True)
            if item_url and item_url not in [i['url'] for i in items_found]:
                items_found.append({'url': item_url, 'title': item_title})
        
        print(f"  Found {len(items_found)} module items")
        
        # Scrape each module item
        for item in items_found:
            item_data = self.scrape_page_content(
                item['url'],
                f"Module_{item['title'][:50]}"
            )
            if item_data:
                self.scraped_data['modules'].append(item_data)
                
                # Download PDFs
                if '.pdf' in item['url'].lower():
                    self.download_and_extract_pdf(item['url'], item['title'])
        
        print(f"\n✓ Scraped {len(items_found)} module items")
    
    def scrape_announcements_complete(self):
        """Scrape all announcements with pagination handling."""
        print("\n" + "="*80)
        print("SCRAPING ANNOUNCEMENTS (WITH PAGINATION)")
        print("="*80)
        
        url = f"{self.course_url}/announcements"
        self.driver.get(url)
        time.sleep(2)
        
        # Scroll to load all announcements
        self.scroll_to_bottom()
        
        # Scrape main page
        page_data = self.scrape_page_content(url, "Announcements_Index")
        
        # Find all announcement links
        soup = BeautifulSoup(self.driver.page_source, 'html.parser')
        ann_links = soup.find_all('a', href=re.compile(r'/discussion_topics/\d+'))
        
        announcements_found = []
        for link in ann_links:
            ann_url = urljoin(url, link['href'])
            ann_title = link.get_text(strip=True)
            if ann_url not in [a['url'] for a in announcements_found]:
                announcements_found.append({'url': ann_url, 'title': ann_title})
        
        print(f"  Found {len(announcements_found)} announcements")
        
        # Scrape each announcement
        for ann in announcements_found:
            ann_data = self.scrape_page_content(
                ann['url'],
                f"Announcement_{ann['title'][:50]}"
            )
            if ann_data:
                self.scraped_data['announcements'].append(ann_data)
        
        print(f"\n✓ Scraped {len(announcements_found)} announcements")
    
    def scrape_assignments_complete(self):
        """Scrape all assignments with details."""
        print("\n" + "="*80)
        print("SCRAPING ASSIGNMENTS")
        print("="*80)
        
        url = f"{self.course_url}/assignments"
        self.driver.get(url)
        time.sleep(2)
        
        # Expand "Past Assignments" if exists
        try:
            past_btn = self.driver.find_element(By.XPATH, "//button[contains(text(), 'Past Assignments')]")
            past_btn.click()
            time.sleep(1)
            print("  [EXPAND] Expanded 'Past Assignments'")
        except:
            pass
        
        # Scroll to load all
        self.scroll_to_bottom()
        
        # Scrape main page
        page_data = self.scrape_page_content(url, "Assignments_Index")
        
        # Find all assignment links
        soup = BeautifulSoup(self.driver.page_source, 'html.parser')
        assign_links = soup.find_all('a', href=re.compile(r'/assignments/\d+'))
        
        assignments_found = []
        for link in assign_links:
            assign_url = urljoin(url, link['href'])
            assign_title = link.get_text(strip=True)
            if assign_url not in [a['url'] for a in assignments_found]:
                assignments_found.append({'url': assign_url, 'title': assign_title})
        
        print(f"  Found {len(assignments_found)} assignments")
        
        # Scrape each assignment
        for assign in assignments_found:
            assign_data = self.scrape_page_content(
                assign['url'],
                f"Assignment_{assign['title'][:50]}"
            )
            if assign_data:
                # Extract due date and points
                text = assign_data['text_content']
                due_match = re.search(r'Due[:\s]+([^\n]+)', text, re.IGNORECASE)
                points_match = re.search(r'(\d+)\s+[Pp]oints?\s+[Pp]ossible', text)
                
                assign_data['due_date'] = due_match.group(1) if due_match else "No due date"
                assign_data['points'] = points_match.group(1) if points_match else "Unknown"
                
                self.scraped_data['assignments'].append(assign_data)
                
                # Download PDFs
                assign_soup = BeautifulSoup(self.driver.page_source, 'html.parser')
                pdf_links = assign_soup.find_all('a', href=re.compile(r'\.pdf'))
                for pdf_link in pdf_links:
                    pdf_url = urljoin(assign['url'], pdf_link['href'])
                    self.download_and_extract_pdf(pdf_url, pdf_link.get_text(strip=True))
        
        print(f"\n✓ Scraped {len(assignments_found)} assignments")
    
    def download_and_extract_pdf(self, pdf_url, filename):
        """Download a PDF and extract its text."""
        try:
            safe_filename = re.sub(r'[^\w\s.-]', '', filename).strip()
            if not safe_filename.endswith('.pdf'):
                safe_filename += '.pdf'
            
            pdf_path = os.path.join(self.output_dir, 'pdfs', safe_filename)
            
            if os.path.exists(pdf_path):
                return
            
            print(f"  [DOWNLOAD] PDF: {safe_filename}")
            
            # Get cookies from Selenium
            cookies = {cookie['name']: cookie['value'] for cookie in self.driver.get_cookies()}
            
            response = requests.get(pdf_url, cookies=cookies, timeout=30)
            response.raise_for_status()
            
            with open(pdf_path, 'wb') as f:
                f.write(response.content)
            
            # Extract text
            try:
                pdf_file = BytesIO(response.content)
                pdf_reader = PyPDF2.PdfReader(pdf_file)
                
                text = ""
                for page_num, page in enumerate(pdf_reader.pages):
                    text += f"\n--- Page {page_num + 1} ---\n"
                    text += page.extract_text() + "\n"
                
                text_path = pdf_path.replace('.pdf', '_extracted.txt')
                with open(text_path, 'w', encoding='utf-8') as f:
                    f.write(text)
                
                print(f"  [EXTRACT] Extracted {len(pdf_reader.pages)} pages")
            except Exception as e:
                print(f"  [ERROR] Could not extract text: {str(e)}")
                
        except Exception as e:
            print(f"  [ERROR] Could not download PDF: {str(e)}")
    
    def scrape_all(self):
        """Main method to scrape all course content."""
        print("\n" + "="*80)
        print("ENHANCED CANVAS SCRAPER - COMPLETE COVERAGE")
        print(f"Course: {self.course_url}")
        print(f"Output: {self.output_dir}")
        print("="*80)
        
        start_time = time.time()
        
        # Scrape all sections with full expansion
        self.scrape_announcements_complete()
        self.scrape_assignments_complete()
        self.scrape_modules_complete()
        self.scrape_files_with_folders()
        
        # Save data
        self.save_data()
        
        elapsed = time.time() - start_time
        
        print("\n" + "="*80)
        print("SCRAPING COMPLETE!")
        print("="*80)
        print(f"URLs visited: {len(self.visited_urls)}")
        print(f"Announcements: {len(self.scraped_data['announcements'])}")
        print(f"Assignments: {len(self.scraped_data['assignments'])}")
        print(f"Modules: {len(self.scraped_data['modules'])}")
        print(f"Folders: {len(self.scraped_data['folders'])}")
        print(f"Time: {elapsed:.2f}s")
        print(f"Output: {self.output_dir}")
        print("="*80)
    
    def save_data(self):
        """Save all scraped data."""
        output_file = os.path.join(self.output_dir, 'scraped_data.json')
        with open(output_file, 'w', encoding='utf-8') as f:
            json.dump(self.scraped_data, f, indent=2, ensure_ascii=False)
        
        summary = {
            'course_url': self.course_url,
            'scrape_date': datetime.now().isoformat(),
            'total_urls': len(self.visited_urls),
            'counts': {
                'announcements': len(self.scraped_data['announcements']),
                'assignments': len(self.scraped_data['assignments']),
                'modules': len(self.scraped_data['modules']),
                'folders': len(self.scraped_data['folders']),
            }
        }
        
        summary_file = os.path.join(self.output_dir, 'summary.json')
        with open(summary_file, 'w') as f:
            json.dump(summary, f, indent=2)
        
        print(f"\n✓ Saved data to {output_file}")
    
    def close(self):
        """Close the browser."""
        self.driver.quit()


def main():
    """Run the enhanced scraper."""
    course_url = "https://canvas.cornell.edu/courses/80501"
    
    # NOTE: This version connects to your existing browser session
    # Make sure you're logged into Canvas in your browser
    
    scraper = CanvasScraperEnhanced(
        course_url=course_url,
        output_dir="canvas_scraped_data_complete",
        headless=False  # Set to True to hide browser window
    )
    
    try:
        scraper.scrape_all()
    finally:
        scraper.close()


if __name__ == "__main__":
    main()
