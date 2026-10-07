"""Synthetic STEP fixtures; native writer is a build-time fixture authoring tool only."""
import re
from pathlib import Path
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
from OCP.BRepBuilderAPI import BRepBuilderAPI_MakePolygon, BRepBuilderAPI_MakeFace
from OCP.BRep import BRep_Builder
from OCP.TopoDS import TopoDS_Compound, TopoDS_Shell, TopoDS
from OCP.TopExp import TopExp_Explorer
from OCP.TopAbs import TopAbs_FACE
from OCP.TopLoc import TopLoc_Location
from OCP.gp import gp_Trsf,gp_Vec,gp_Pnt
from OCP.XCAFApp import XCAFApp_Application
from OCP.XCAFDoc import XCAFDoc_DocumentTool, XCAFDoc_ColorGen, XCAFDoc_ColorSurf
from OCP.TCollection import TCollection_ExtendedString
from OCP.TDocStd import TDocStd_Document
from OCP.TDataStd import TDataStd_Name
from OCP.Quantity import Quantity_Color, Quantity_ColorRGBA, Quantity_TOC_RGB
from OCP.STEPCAFControl import STEPCAFControl_Writer
from OCP.Interface import Interface_Static
from OCP.IFSelect import IFSelect_RetDone

def document():
 d=TDocStd_Document(TCollection_ExtendedString('XmlXCAF'))
 XCAFApp_Application.GetApplication_s().NewDocument(TCollection_ExtendedString('MDTV-XCAF'),d)
 return d,XCAFDoc_DocumentTool.ShapeTool_s(d.Main()),XCAFDoc_DocumentTool.ColorTool_s(d.Main())
def name(l,n): TDataStd_Name.Set_s(l,TCollection_ExtendedString(n))
def rgb(r,g,b):return Quantity_Color(r,g,b,Quantity_TOC_RGB)
def location(x,y,z):
 t=gp_Trsf();t.SetTranslation(gp_Vec(x,y,z));return TopLoc_Location(t)
def assembly(st,n):
 c=TopoDS_Compound();BRep_Builder().MakeCompound(c);a=st.AddShape(c,True);name(a,n);return a
def write(d,st,filename):
 st.UpdateAssemblies();w=STEPCAFControl_Writer();w.SetColorMode(True);w.SetNameMode(True)
 Interface_Static.SetCVal_s('write.step.schema','AP214IS');assert w.Transfer(d);assert w.Write(str(filename))==IFSelect_RetDone
 # Stable synthetic fixture header: no workstation, author or wall-clock values.
 text=filename.read_text();text=re.sub(r"FILE_NAME\(.*?\);", "FILE_NAME('synthetic.step','2000-01-01T00:00:00',(''),(''),'Open CASCADE','Synthetic WireHub regression','');",text,flags=re.S)
 filename.write_text(text)

def alpha(out):
 d,st,ct=document();a=assembly(st,'Synthetic alpha assembly')
 shape=BRepPrimAPI_MakeBox(2,3,1).Shape();p=st.AddShape(shape,False);name(p,'Synthetic alpha product')
 ct.SetColor(p,Quantity_ColorRGBA(rgb(.2,.4,.6),.6),XCAFDoc_ColorSurf)
 face=st.AddSubShape(p,TopExp_Explorer(shape,TopAbs_FACE).Current())
 ct.SetColor(face,Quantity_ColorRGBA(rgb(.2,.4,.6),0),XCAFDoc_ColorSurf)
 for label,delta,opacity in [('Synthetic transparent occurrence',0,.25),('Synthetic translucent occurrence',5,.75)]:
  l=st.AddComponent(a,p,location(delta,0,0));name(l,label)
  ct.SetColor(l,Quantity_ColorRGBA(rgb(.2,.4,.6),opacity),XCAFDoc_ColorSurf)
 write(d,st,out/'occurrence-alpha.step')
alpha(Path(__file__).parent)

def product_alpha(out):
 d,st,ct=document()
 p=st.AddShape(BRepPrimAPI_MakeBox(2,3,1).Shape(),False);name(p,'Synthetic translucent product')
 ct.SetColor(p,Quantity_ColorRGBA(rgb(.2,.4,.6),.4),XCAFDoc_ColorSurf)
 write(d,st,out/'product-alpha.step')
product_alpha(Path(__file__).parent)
