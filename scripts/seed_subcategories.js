// scripts/seed_subcategories.js
require('dotenv').config();
const db = require('../config/db');

const CATEGORY_DATA = {
  'Fashion': [
    {
      name: "Men's Clothing",
      fields: [
        { key: 'brand', label: 'Brand', type: 'text', required: false },
        { key: 'category_type', label: 'Category Type', type: 'select', options: ['T-Shirt','Shirt','Trouser','Suit','Jacket','Shorts','Underwear'], required: true },
        { key: 'size', label: 'Size', type: 'multiselect', options: ['XS','S','M','L','XL','XXL','XXXL'], required: true },
        { key: 'color', label: 'Color', type: 'tags', required: true },
        { key: 'material', label: 'Material', type: 'text', required: false },
        { key: 'pattern', label: 'Pattern', type: 'select', options: ['Plain','Striped','Checked','Printed','Floral'], required: false },
        { key: 'condition', label: 'Condition', type: 'select', options: ['New','Fairly Used'], required: true }
      ]
    },
    {
      name: "Women's Clothing",
      fields: [
        { key: 'brand', label: 'Brand', type: 'text', required: false },
        { key: 'size', label: 'Size', type: 'multiselect', options: ['XS','S','M','L','XL','XXL'], required: true },
        { key: 'color', label: 'Color', type: 'tags', required: true },
        { key: 'material', label: 'Material', type: 'text', required: false },
        { key: 'style', label: 'Style', type: 'select', options: ['Casual','Formal','Sporty','Elegant','Bohemian'], required: false },
        { key: 'condition', label: 'Condition', type: 'select', options: ['New','Fairly Used'], required: true }
      ]
    },
    {
      name: "Children's Clothing",
      fields: [
        { key: 'brand', label: 'Brand', type: 'text', required: false },
        { key: 'age_range', label: 'Age Range', type: 'select', options: ['0-1yr','1-2yrs','2-4yrs','4-6yrs','6-8yrs','8-10yrs','10-12yrs'], required: true },
        { key: 'size', label: 'Size', type: 'multiselect', options: ['XS','S','M','L','XL'], required: false },
        { key: 'color', label: 'Color', type: 'tags', required: true },
        { key: 'material', label: 'Material', type: 'text', required: false },
        { key: 'gender', label: 'Gender', type: 'select', options: ['Boys','Girls','Unisex'], required: true }
      ]
    },
    {
      name: 'Shoes',
      fields: [
        { key: 'brand', label: 'Brand', type: 'text', required: false },
        { key: 'gender', label: 'Gender', type: 'select', options: ['Men','Women','Unisex','Kids'], required: true },
        { key: 'size', label: 'Size', type: 'multiselect', options: ['36','37','38','39','40','41','42','43','44','45','46'], required: true },
        { key: 'color', label: 'Color', type: 'tags', required: true },
        { key: 'material', label: 'Material', type: 'select', options: ['Leather','Canvas','Rubber','Suede','Synthetic'], required: false },
        { key: 'shoe_type', label: 'Shoe Type', type: 'select', options: ['Sneakers','Heels','Sandals','Boots','Loafers','Flats','Slippers'], required: true },
        { key: 'condition', label: 'Condition', type: 'select', options: ['New','Fairly Used'], required: true }
      ]
    },
    {
      name: 'Bags',
      fields: [
        { key: 'brand', label: 'Brand', type: 'text', required: false },
        { key: 'bag_type', label: 'Bag Type', type: 'select', options: ['Handbag','Backpack','Wallet','Clutch','Tote','Briefcase','Duffle'], required: true },
        { key: 'material', label: 'Material', type: 'select', options: ['Leather','Canvas','Nylon','PU Leather','Fabric'], required: false },
        { key: 'color', label: 'Color', type: 'tags', required: true },
        { key: 'condition', label: 'Condition', type: 'select', options: ['New','Fairly Used'], required: true }
      ]
    },
    {
      name: 'Watches',
      fields: [
        { key: 'brand', label: 'Brand', type: 'text', required: false },
        { key: 'gender', label: 'Gender', type: 'select', options: ['Men','Women','Unisex'], required: true },
        { key: 'watch_type', label: 'Watch Type', type: 'select', options: ['Analog','Digital','Smart','Hybrid'], required: true },
        { key: 'strap_material', label: 'Strap Material', type: 'select', options: ['Leather','Metal','Rubber','Fabric'], required: false },
        { key: 'color', label: 'Color', type: 'tags', required: true },
        { key: 'condition', label: 'Condition', type: 'select', options: ['New','Fairly Used'], required: true }
      ]
    },
    {
      name: 'Jewelry',
      fields: [
        { key: 'jewelry_type', label: 'Jewelry Type', type: 'select', options: ['Ring','Necklace','Bracelet','Earrings','Anklet','Brooch'], required: true },
        { key: 'material', label: 'Material', type: 'select', options: ['Gold','Silver','Rose Gold','Platinum','Stainless Steel','Beads'], required: true },
        { key: 'color', label: 'Color', type: 'tags', required: false },
        { key: 'gender', label: 'Gender', type: 'select', options: ['Men','Women','Unisex'], required: false },
        { key: 'condition', label: 'Condition', type: 'select', options: ['New','Fairly Used'], required: true }
      ]
    },
    {
      name: 'Wigs & Hair Extensions',
      fields: [
        { key: 'hair_type', label: 'Hair Type', type: 'select', options: ['Human Hair','Synthetic','Blend'], required: true },
        { key: 'length', label: 'Length (inches)', type: 'text', required: true },
        { key: 'color', label: 'Color', type: 'tags', required: true },
        { key: 'texture', label: 'Texture', type: 'select', options: ['Straight','Wavy','Curly','Kinky','Afro'], required: true },
        { key: 'weight', label: 'Weight (grams)', type: 'text', required: false },
        { key: 'condition', label: 'Condition', type: 'select', options: ['New','Fairly Used'], required: true }
      ]
    }
  ],
  'Beauty & Personal Care': [
    {
      name: 'Skincare',
      fields: [
        { key: 'brand', label: 'Brand', type: 'text', required: false },
        { key: 'skin_type', label: 'Skin Type', type: 'select', options: ['All Skin Types','Oily','Dry','Combination','Sensitive'], required: false },
        { key: 'product_type', label: 'Product Type', type: 'select', options: ['Moisturizer','Cleanser','Serum','Toner','SPF','Eye Cream','Face Mask'], required: true },
        { key: 'volume', label: 'Volume/Size', type: 'text', required: false },
        { key: 'expiry_date', label: 'Expiry Date', type: 'date', required: false }
      ]
    },
    {
      name: 'Makeup',
      fields: [
        { key: 'brand', label: 'Brand', type: 'text', required: false },
        { key: 'makeup_type', label: 'Makeup Type', type: 'select', options: ['Foundation','Lipstick','Eyeshadow','Mascara','Blush','Concealer','Highlighter','Powder'], required: true },
        { key: 'shade', label: 'Shade/Color', type: 'text', required: false },
        { key: 'volume', label: 'Volume/Size', type: 'text', required: false },
        { key: 'expiry_date', label: 'Expiry Date', type: 'date', required: false }
      ]
    },
    {
      name: 'Perfumes',
      fields: [
        { key: 'brand', label: 'Brand', type: 'text', required: false },
        { key: 'gender', label: 'Gender', type: 'select', options: ['Men','Women','Unisex'], required: true },
        { key: 'fragrance_type', label: 'Fragrance Type', type: 'select', options: ['Eau de Parfum','Eau de Toilette','Cologne','Body Mist'], required: true },
        { key: 'volume', label: 'Volume (ml)', type: 'text', required: true }
      ]
    },
    {
      name: 'Hair Care',
      fields: [
        { key: 'brand', label: 'Brand', type: 'text', required: false },
        { key: 'hair_type', label: 'Hair Type', type: 'select', options: ['All Hair Types','Natural','Relaxed','Dry','Oily','Curly'], required: false },
        { key: 'product_type', label: 'Product Type', type: 'select', options: ['Shampoo','Conditioner','Hair Oil','Hair Cream','Leave-In','Hair Mask','Growth Serum'], required: true },
        { key: 'volume', label: 'Volume/Size', type: 'text', required: false },
        { key: 'expiry_date', label: 'Expiry Date', type: 'date', required: false }
      ]
    },
    {
      name: 'Beauty Tools',
      fields: [
        { key: 'brand', label: 'Brand', type: 'text', required: false },
        { key: 'tool_type', label: 'Tool Type', type: 'select', options: ['Hair Dryer','Flat Iron','Curler','Trimmer','Epilator','Facial Steamer','Massager'], required: true },
        { key: 'power_source', label: 'Power Source', type: 'select', options: ['Electric','Battery','USB','Manual'], required: false },
        { key: 'color', label: 'Color', type: 'tags', required: false },
        { key: 'condition', label: 'Condition', type: 'select', options: ['New','Fairly Used'], required: true }
      ]
    }
  ],
  'Phones & Gadgets': [
    {
      name: 'Smartphones',
      fields: [
        { key: 'brand', label: 'Brand', type: 'select', options: ['Apple','Samsung','Tecno','Infinix','Itel','Xiaomi','Nokia','Other'], required: true },
        { key: 'model', label: 'Model', type: 'text', required: true },
        { key: 'storage', label: 'Storage', type: 'multiselect', options: ['16GB','32GB','64GB','128GB','256GB','512GB','1TB'], required: true },
        { key: 'ram', label: 'RAM', type: 'multiselect', options: ['2GB','3GB','4GB','6GB','8GB','12GB','16GB'], required: false },
        { key: 'color', label: 'Color', type: 'tags', required: true },
        { key: 'operating_system', label: 'OS', type: 'select', options: ['Android','iOS'], required: true },
        { key: 'condition', label: 'Condition', type: 'select', options: ['Brand New','UK Used','Nigerian Used'], required: true },
        { key: 'battery_health', label: 'Battery Health (%)', type: 'text', required: false },
        { key: 'warranty', label: 'Warranty', type: 'select', options: ['No Warranty','1 Month','3 Months','6 Months','1 Year'], required: false }
      ]
    },
    {
      name: 'Tablets',
      fields: [
        { key: 'brand', label: 'Brand', type: 'text', required: true },
        { key: 'model', label: 'Model', type: 'text', required: true },
        { key: 'storage', label: 'Storage', type: 'multiselect', options: ['16GB','32GB','64GB','128GB','256GB'], required: true },
        { key: 'ram', label: 'RAM', type: 'multiselect', options: ['1GB','2GB','3GB','4GB','6GB','8GB'], required: false },
        { key: 'screen_size', label: 'Screen Size (inches)', type: 'text', required: false },
        { key: 'condition', label: 'Condition', type: 'select', options: ['Brand New','UK Used','Nigerian Used'], required: true }
      ]
    },
    {
      name: 'Smartwatches',
      fields: [
        { key: 'brand', label: 'Brand', type: 'text', required: true },
        { key: 'model', label: 'Model', type: 'text', required: false },
        { key: 'strap_material', label: 'Strap Material', type: 'select', options: ['Silicone','Metal','Leather','Fabric'], required: false },
        { key: 'connectivity', label: 'Connectivity', type: 'multiselect', options: ['Bluetooth','WiFi','4G','GPS'], required: false },
        { key: 'condition', label: 'Condition', type: 'select', options: ['Brand New','UK Used','Nigerian Used'], required: true }
      ]
    },
    {
      name: 'Earbuds & Headphones',
      fields: [
        { key: 'brand', label: 'Brand', type: 'text', required: false },
        { key: 'type', label: 'Type', type: 'select', options: ['In-Ear','Over-Ear','On-Ear','True Wireless'], required: true },
        { key: 'connectivity', label: 'Connectivity', type: 'select', options: ['Wired','Wireless (Bluetooth)','Both'], required: true },
        { key: 'battery_life', label: 'Battery Life (hrs)', type: 'text', required: false },
        { key: 'condition', label: 'Condition', type: 'select', options: ['Brand New','UK Used','Nigerian Used'], required: true }
      ]
    },
    {
      name: 'Power Banks',
      fields: [
        { key: 'brand', label: 'Brand', type: 'text', required: false },
        { key: 'capacity', label: 'Capacity (mAh)', type: 'select', options: ['5000mAh','10000mAh','20000mAh','30000mAh','Others'], required: true },
        { key: 'output_power', label: 'Output Power', type: 'text', required: false },
        { key: 'condition', label: 'Condition', type: 'select', options: ['Brand New','UK Used','Nigerian Used'], required: true }
      ]
    },
    {
      name: 'Phone Accessories',
      fields: [
        { key: 'brand', label: 'Brand', type: 'text', required: false },
        { key: 'accessory_type', label: 'Accessory Type', type: 'select', options: ['Case','Screen Protector','Charger','Cable','Pop Socket','Ring Light','Tripod','Other'], required: true },
        { key: 'compatible_devices', label: 'Compatible Devices', type: 'text', required: false },
        { key: 'color', label: 'Color', type: 'tags', required: false },
        { key: 'condition', label: 'Condition', type: 'select', options: ['New','Fairly Used'], required: true }
      ]
    }
  ],
  'Computers & Electronics': [
    {
      name: 'Laptops',
      fields: [
        { key: 'brand', label: 'Brand', type: 'select', options: ['Apple','Dell','HP','Lenovo','Asus','Acer','MSI','Toshiba','Other'], required: true },
        { key: 'model', label: 'Model', type: 'text', required: false },
        { key: 'processor', label: 'Processor', type: 'text', required: false },
        { key: 'ram', label: 'RAM', type: 'multiselect', options: ['4GB','8GB','16GB','32GB','64GB'], required: true },
        { key: 'storage', label: 'Storage', type: 'multiselect', options: ['128GB SSD','256GB SSD','512GB SSD','1TB SSD','1TB HDD','2TB HDD'], required: true },
        { key: 'graphics_card', label: 'Graphics Card', type: 'text', required: false },
        { key: 'screen_size', label: 'Screen Size (inches)', type: 'text', required: false },
        { key: 'condition', label: 'Condition', type: 'select', options: ['Brand New','UK Used','Nigerian Used'], required: true },
        { key: 'warranty', label: 'Warranty', type: 'select', options: ['No Warranty','1 Month','3 Months','6 Months','1 Year'], required: false }
      ]
    },
    {
      name: 'Desktop Computers',
      fields: [
        { key: 'brand', label: 'Brand', type: 'text', required: false },
        { key: 'processor', label: 'Processor', type: 'text', required: false },
        { key: 'ram', label: 'RAM', type: 'multiselect', options: ['4GB','8GB','16GB','32GB','64GB'], required: false },
        { key: 'storage', label: 'Storage', type: 'multiselect', options: ['256GB SSD','512GB SSD','1TB HDD','2TB HDD'], required: false },
        { key: 'graphics_card', label: 'Graphics Card', type: 'text', required: false },
        { key: 'condition', label: 'Condition', type: 'select', options: ['Brand New','UK Used','Nigerian Used'], required: true }
      ]
    },
    {
      name: 'Monitors',
      fields: [
        { key: 'brand', label: 'Brand', type: 'text', required: false },
        { key: 'screen_size', label: 'Screen Size (inches)', type: 'text', required: true },
        { key: 'resolution', label: 'Resolution', type: 'select', options: ['HD (1280x720)','Full HD (1920x1080)','2K (2560x1440)','4K (3840x2160)'], required: false },
        { key: 'refresh_rate', label: 'Refresh Rate (Hz)', type: 'select', options: ['60Hz','75Hz','100Hz','144Hz','165Hz','240Hz'], required: false },
        { key: 'condition', label: 'Condition', type: 'select', options: ['Brand New','UK Used','Nigerian Used'], required: true }
      ]
    },
    {
      name: 'Printers',
      fields: [
        { key: 'brand', label: 'Brand', type: 'text', required: false },
        { key: 'printer_type', label: 'Printer Type', type: 'select', options: ['Inkjet','Laser','Thermal','All-in-One'], required: true },
        { key: 'connectivity', label: 'Connectivity', type: 'multiselect', options: ['USB','WiFi','Bluetooth','Ethernet'], required: false },
        { key: 'condition', label: 'Condition', type: 'select', options: ['Brand New','UK Used','Nigerian Used'], required: true }
      ]
    },
    {
      name: 'Computer Accessories',
      fields: [
        { key: 'brand', label: 'Brand', type: 'text', required: false },
        { key: 'accessory_type', label: 'Accessory Type', type: 'select', options: ['Keyboard','Mouse','Webcam','USB Hub','Cooling Pad','Hard Drive','Flash Drive','Other'], required: true },
        { key: 'compatibility', label: 'Compatibility', type: 'text', required: false },
        { key: 'condition', label: 'Condition', type: 'select', options: ['New','Fairly Used'], required: true }
      ]
    },
    {
      name: 'Speakers & Audio Systems',
      fields: [
        { key: 'brand', label: 'Brand', type: 'text', required: false },
        { key: 'audio_type', label: 'Audio Type', type: 'select', options: ['Bluetooth Speaker','Home Theater','Soundbar','Woofer','Hi-Fi System'], required: true },
        { key: 'connectivity', label: 'Connectivity', type: 'multiselect', options: ['Bluetooth','AUX','USB','WiFi'], required: false },
        { key: 'power_output', label: 'Power Output (W)', type: 'text', required: false },
        { key: 'condition', label: 'Condition', type: 'select', options: ['Brand New','UK Used','Nigerian Used'], required: true }
      ]
    }
  ],
  'Home & Kitchen': [
    {
      name: 'Kitchen Appliances',
      fields: [
        { key: 'brand', label: 'Brand', type: 'text', required: false },
        { key: 'appliance_type', label: 'Appliance Type', type: 'select', options: ['Blender','Microwave','Gas Cooker','Electric Cooker','Air Fryer','Rice Cooker','Toaster','Fridge','Washing Machine','Other'], required: true },
        { key: 'power_rating', label: 'Power Rating (W)', type: 'text', required: false },
        { key: 'color', label: 'Color', type: 'tags', required: false },
        { key: 'condition', label: 'Condition', type: 'select', options: ['Brand New','UK Used','Nigerian Used'], required: true },
        { key: 'warranty', label: 'Warranty', type: 'select', options: ['No Warranty','3 Months','6 Months','1 Year'], required: false }
      ]
    },
    {
      name: 'Cookware',
      fields: [
        { key: 'brand', label: 'Brand', type: 'text', required: false },
        { key: 'material', label: 'Material', type: 'select', options: ['Stainless Steel','Cast Iron','Non-Stick','Aluminum','Ceramic'], required: true },
        { key: 'set_size', label: 'Set Size (pieces)', type: 'text', required: false },
        { key: 'color', label: 'Color', type: 'tags', required: false },
        { key: 'condition', label: 'Condition', type: 'select', options: ['New','Fairly Used'], required: true }
      ]
    },
    {
      name: 'Home Decor',
      fields: [
        { key: 'decor_type', label: 'Decor Type', type: 'select', options: ['Wall Art','Vase','Candles','Throw Pillows','Curtains','Rug','Clock','Mirror','Plant Pot','Other'], required: true },
        { key: 'material', label: 'Material', type: 'text', required: false },
        { key: 'color', label: 'Color', type: 'tags', required: false },
        { key: 'dimensions', label: 'Dimensions', type: 'text', required: false },
        { key: 'condition', label: 'Condition', type: 'select', options: ['New','Fairly Used'], required: true }
      ]
    },
    {
      name: 'Bedding',
      fields: [
        { key: 'bedding_type', label: 'Bedding Type', type: 'select', options: ['Bedsheet Set','Duvet','Pillow','Blanket','Mattress Protector'], required: true },
        { key: 'size', label: 'Size', type: 'select', options: ['Single','Double','Queen','King'], required: true },
        { key: 'material', label: 'Material', type: 'select', options: ['Cotton','Polyester','Microfiber','Linen','Silk'], required: false },
        { key: 'color', label: 'Color', type: 'tags', required: true }
      ]
    },
    {
      name: 'Cleaning Supplies',
      fields: [
        { key: 'brand', label: 'Brand', type: 'text', required: false },
        { key: 'product_type', label: 'Product Type', type: 'select', options: ['Detergent','Disinfectant','Air Freshener','Mop & Bucket','Broom','Other'], required: true },
        { key: 'volume', label: 'Volume/Quantity', type: 'text', required: false },
        { key: 'expiry_date', label: 'Expiry Date', type: 'date', required: false }
      ]
    },
    {
      name: 'Storage & Organization',
      fields: [
        { key: 'material', label: 'Material', type: 'select', options: ['Plastic','Metal','Wood','Fabric'], required: false },
        { key: 'dimensions', label: 'Dimensions', type: 'text', required: false },
        { key: 'color', label: 'Color', type: 'tags', required: false },
        { key: 'storage_type', label: 'Storage Type', type: 'select', options: ['Shelf','Box','Rack','Drawer','Hanger','Other'], required: true }
      ]
    }
  ],
  'Sports': [
    {
      name: 'Jerseys',
      fields: [
        { key: 'team', label: 'Team/Club', type: 'text', required: true },
        { key: 'size', label: 'Size', type: 'multiselect', options: ['XS','S','M','L','XL','XXL'], required: true },
        { key: 'color', label: 'Color', type: 'tags', required: true },
        { key: 'material', label: 'Material', type: 'text', required: false },
        { key: 'condition', label: 'Condition', type: 'select', options: ['New','Fairly Used'], required: true }
      ]
    },
    {
      name: 'Football Boots',
      fields: [
        { key: 'brand', label: 'Brand', type: 'text', required: false },
        { key: 'size', label: 'Size', type: 'multiselect', options: ['36','37','38','39','40','41','42','43','44','45'], required: true },
        { key: 'surface_type', label: 'Surface Type', type: 'select', options: ['Firm Ground (FG)','Soft Ground (SG)','Artificial Ground (AG)','Indoor (IC)'], required: true },
        { key: 'color', label: 'Color', type: 'tags', required: true },
        { key: 'condition', label: 'Condition', type: 'select', options: ['New','Fairly Used'], required: true }
      ]
    },
    {
      name: 'Gym Equipment',
      fields: [
        { key: 'brand', label: 'Brand', type: 'text', required: false },
        { key: 'equipment_type', label: 'Equipment Type', type: 'select', options: ['Dumbbell','Barbell','Treadmill','Exercise Bike','Bench','Resistance Bands','Pull-Up Bar','Other'], required: true },
        { key: 'weight', label: 'Weight (kg)', type: 'text', required: false },
        { key: 'material', label: 'Material', type: 'text', required: false },
        { key: 'condition', label: 'Condition', type: 'select', options: ['New','Fairly Used'], required: true }
      ]
    },
    {
      name: 'Fitness Accessories',
      fields: [
        { key: 'brand', label: 'Brand', type: 'text', required: false },
        { key: 'accessory_type', label: 'Accessory Type', type: 'select', options: ['Water Bottle','Gym Bag','Fitness Tracker','Yoga Mat','Gloves','Belt','Other'], required: true },
        { key: 'material', label: 'Material', type: 'text', required: false },
        { key: 'condition', label: 'Condition', type: 'select', options: ['New','Fairly Used'], required: true }
      ]
    },
    {
      name: 'Outdoor Equipment',
      fields: [
        { key: 'equipment_type', label: 'Equipment Type', type: 'select', options: ['Tent','Camping Chair','Sleeping Bag','Backpack','Hiking Boots','Flashlight','Other'], required: true },
        { key: 'material', label: 'Material', type: 'text', required: false },
        { key: 'weight', label: 'Weight (kg)', type: 'text', required: false },
        { key: 'condition', label: 'Condition', type: 'select', options: ['New','Fairly Used'], required: true }
      ]
    }
  ],
  'Toys': [
    {
      name: 'Educational Toys',
      fields: [
        { key: 'brand', label: 'Brand', type: 'text', required: false },
        { key: 'age_range', label: 'Age Range', type: 'select', options: ['0-2yrs','2-4yrs','4-6yrs','6-8yrs','8-12yrs'], required: true },
        { key: 'material', label: 'Material', type: 'select', options: ['Plastic','Wood','Fabric','Metal'], required: false },
        { key: 'educational_focus', label: 'Educational Focus', type: 'select', options: ['Math','Language','Science','Art','Motor Skills','Cognitive'], required: false }
      ]
    },
    {
      name: 'Action Figures',
      fields: [
        { key: 'brand', label: 'Brand', type: 'text', required: false },
        { key: 'character', label: 'Character/Series', type: 'text', required: true },
        { key: 'material', label: 'Material', type: 'select', options: ['Plastic','Metal','Rubber'], required: false },
        { key: 'age_range', label: 'Age Range', type: 'select', options: ['3+','6+','8+','12+','18+'], required: true }
      ]
    },
    {
      name: 'Dolls',
      fields: [
        { key: 'brand', label: 'Brand', type: 'text', required: false },
        { key: 'doll_type', label: 'Doll Type', type: 'select', options: ['Fashion Doll','Baby Doll','Rag Doll','Talking Doll'], required: true },
        { key: 'material', label: 'Material', type: 'select', options: ['Plastic','Fabric','Silicone'], required: false },
        { key: 'age_range', label: 'Age Range', type: 'select', options: ['1+','3+','6+','8+'], required: true }
      ]
    },
    {
      name: 'Building Blocks',
      fields: [
        { key: 'brand', label: 'Brand', type: 'text', required: false },
        { key: 'num_pieces', label: 'Number of Pieces', type: 'text', required: false },
        { key: 'material', label: 'Material', type: 'select', options: ['Plastic','Wood','Foam'], required: false },
        { key: 'age_range', label: 'Age Range', type: 'select', options: ['1+','2+','3+','6+','8+','12+'], required: true }
      ]
    },
    {
      name: 'Remote Control Toys',
      fields: [
        { key: 'brand', label: 'Brand', type: 'text', required: false },
        { key: 'toy_type', label: 'Toy Type', type: 'select', options: ['RC Car','RC Drone','RC Boat','RC Helicopter'], required: true },
        { key: 'battery_type', label: 'Battery Type', type: 'select', options: ['AA Batteries','AAA Batteries','Rechargeable'], required: false },
        { key: 'control_range', label: 'Control Range (m)', type: 'text', required: false },
        { key: 'age_range', label: 'Age Range', type: 'select', options: ['3+','6+','8+','12+'], required: true }
      ]
    },
    {
      name: 'Board Games',
      fields: [
        { key: 'brand', label: 'Brand', type: 'text', required: false },
        { key: 'num_players', label: 'Number of Players', type: 'text', required: false },
        { key: 'age_range', label: 'Age Range', type: 'select', options: ['3+','6+','8+','12+','18+'], required: true },
        { key: 'game_type', label: 'Game Type', type: 'select', options: ['Strategy','Party','Educational','Card Game','Classic','Trivia'], required: false }
      ]
    }
  ]
};

async function seedSubcategories() {
  try {
    console.log('🌱 Seeding subcategories...');

    for (const [categoryName, subcats] of Object.entries(CATEGORY_DATA)) {
      // Get category id
      const catRes = await db.query(
        'SELECT id FROM categories WHERE name = $1 AND is_active = true LIMIT 1',
        [categoryName]
      );

      if (!catRes.rows.length) {
        console.log(`⚠️ Category not found: ${categoryName} — skipping`);
        continue;
      }

      const categoryId = catRes.rows[0].id;

      for (const sub of subcats) {
        // Upsert
        await db.query(
          `INSERT INTO subcategories (category_id, name, fields)
           VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING`,
          [categoryId, sub.name, JSON.stringify(sub.fields)]
        );
        console.log(`✅ ${categoryName} → ${sub.name}`);
      }
    }

    console.log('✨ Done!');
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await db.closePool();
    process.exit(0);
  }
}

seedSubcategories();